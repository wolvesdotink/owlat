/**
 * Server-managed desktop updates — the release cache, the instance policy, and
 * the query the public manifest route answers from.
 *
 * The desktop app used to read a hard-coded GitHub URL
 * (`/releases/latest/download/latest.json`), which made desktop-only releases
 * invisible to existing installs and gave an operator no way to hold a bad
 * build back. This module makes the instance the decision point:
 *
 *   1. A six-hourly cron (and the admin "Check now" button) runs
 *      `refreshReleases`, which lists the repo's releases, downloads each new
 *      one's `latest.json`, validates it, and caches it VERBATIM. It pages past
 *      a run of release candidates until it holds a stable release.
 *   2. `manifestForClient` applies `instanceSettings.desktopUpdates` to that
 *      cache through the pure resolver and hands back the stored manifest text.
 *   3. The Nitro route `/api/desktop/update/:target/:arch/:current` serves that
 *      text unchanged, or 204.
 *
 * GitHub stays the byte source and the app stays the verifier: every bundle URL
 * in a cached manifest points at GitHub and every bundle is checked against the
 * minisign key baked into the app. The server can withhold an update; it can
 * never substitute one.
 */
import { v } from 'convex/values';
import {
	GITHUB_REPO_SLUG,
	isValidTargetVersion,
	RELEASE_DOWNLOAD_BASE,
} from '@owlat/shared/releaseArtifacts';
import { parseVersion, semverCompare } from '@owlat/shared/semver';
import { internalAction, internalQuery, type ActionCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { authedMutation, authedQuery, authedAction, publicQuery } from '../lib/authedFunctions';
import { getOptional } from '../lib/env';
import { recordAuditLog } from '../lib/auditLog';
import { upsertInstanceSettings } from '../lib/instanceSettings';
import { hasPermission, requireOrgPermission, requirePermission } from '../lib/sessionOrganization';
import { throwInvalidInput } from '../_utils/errors';
import {
	desktopUpdateChannelValidator,
	desktopUpdateModeValidator,
} from '../lib/literalValidators';
import { isValidManifest, parseDesktopReleaseTag, type GithubRelease } from './releaseManifest';
import {
	activePin,
	DESKTOP_RELEASE_CACHE_LIMIT,
	DESKTOP_RELEASE_READ_LIMIT,
	MAX_DEFER_HOURS,
	type ListedRelease,
	newestRelease,
	oneRowPerVersion,
	preferCachedRelease,
	resolveDesktopUpdate,
	stableReleaseSearch,
} from './updateResolver';
import {
	readCheckState,
	readLastChange,
	readPolicy,
	readReleases,
	readVersionRows,
} from './updateReads';
import {
	cachedReleaseValidator,
	cacheReleaseRow,
	pruneReleaseCache,
	recordCheckState,
	type CachedRelease,
} from './refreshCommit';

// ── Constants ────────────────────────────────────────────────────────────────

const GITHUB_RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO_SLUG}/releases?per_page=${DESKTOP_RELEASE_CACHE_LIMIT}`;

/** Release bodies are shown on the admin page; clamp what we store. */
const NOTES_MAX_CHARS = 8000;

// ── Internal cache plumbing ──────────────────────────────────────────────────

export const listCachedTagsInternal = internalQuery({
	args: {},
	handler: async (ctx): Promise<string[]> => {
		const rows = await ctx.db
			.query('desktopReleases')
			.withIndex('by_kind_and_version', (q) => q.eq('kind', 'release'))
			.take(DESKTOP_RELEASE_READ_LIMIT);
		return rows.map((row) => row.tag ?? '').filter((tag) => tag.length > 0);
	},
});

export const getPolicyInternal = internalQuery({
	args: {},
	handler: async (ctx) => await readPolicy(ctx),
});

export const getCheckStateInternal = internalQuery({
	args: {},
	handler: async (ctx) => {
		const row = await readCheckState(ctx);
		return { checkedAt: row?.checkedAt ?? null, error: row?.error ?? null };
	},
});

// A previous release's refresh writes through the three mutations below.
// Nothing in this release calls them; remove after release 0.6.17.
export const cacheRelease = internalMutation({
	args: cachedReleaseValidator.fields,
	handler: async (ctx, args): Promise<Id<'desktopReleases'>> => await cacheReleaseRow(ctx, args),
});

export const recordCheck = internalMutation({
	args: { error: v.optional(v.string()) },
	handler: async (ctx, args) => await recordCheckState(ctx, args.error),
});

export const pruneReleases = internalMutation({
	args: {},
	handler: async (ctx) => await pruneReleaseCache(ctx),
});

// ── Refresh (cron + admin button) ────────────────────────────────────────────

/**
 * Download and validate one release's `latest.json`. Null when the release
 * shipped no desktop bundle (the server-only line, or a unified release that
 * predates the updater) or its manifest failed validation.
 */
async function fetchRelease(
	release: GithubRelease,
	listed: ListedRelease,
	headers: { 'User-Agent': string }
): Promise<CachedRelease | null> {
	const tag = release.tag_name ?? '';
	const manifestResp = await fetch(`${RELEASE_DOWNLOAD_BASE}/${tag}/latest.json`, {
		headers: { 'User-Agent': headers['User-Agent'] },
	});
	if (!manifestResp.ok) return null;

	const manifest = await manifestResp.text();
	if (!isValidManifest(manifest, listed.version)) {
		console.warn(`desktop updates: rejected manifest for ${tag} (failed validation)`);
		return null;
	}

	return {
		tag,
		version: listed.version,
		line: listed.line,
		isPrerelease: listed.isPrerelease,
		publishedAt: listed.publishedAt,
		notes: (release.body ?? '').slice(0, NOTES_MAX_CHARS),
		manifest,
	};
}

/**
 * List the releases and download each new one's manifest. Never throws: a
 * failure ends the walk with what it downloaded so far and the error.
 */
async function walkReleases(
	ctx: ActionCtx,
	headers: { Accept: string; 'User-Agent': string; 'X-GitHub-Api-Version': string }
): Promise<{ releases: CachedRelease[]; prune: boolean; error?: string }> {
	const releases: CachedRelease[] = [];
	try {
		const [known, policy] = await Promise.all([
			ctx
				.runQuery(internal.desktop.updates.listCachedTagsInternal, {})
				.then((tags) => new Set(tags)),
			ctx.runQuery(internal.desktop.updates.getPolicyInternal, {}),
		]);
		const search = stableReleaseSearch(policy.deferHours, Date.now());
		let pageError: string | undefined;

		for (let page = 1; ; page++) {
			const resp = await fetch(`${GITHUB_RELEASES_URL}&page=${page}`, { headers });
			if (!resp.ok) {
				pageError =
					resp.status === 403 || resp.status === 429
						? 'rate_limited'
						: `GitHub API returned ${resp.status}`;
				// Nothing listed yet: record it and leave the cache exactly as it
				// was, so clients keep being served what we already know about.
				if (page === 1) return { releases, prune: false, error: pageError };
				break;
			}

			const body: unknown = await resp.json();
			const listing = Array.isArray(body) ? (body as GithubRelease[]) : [];
			for (const release of listing) {
				const tag = release.tag_name ?? '';
				const parsed = release.draft ? null : parseDesktopReleaseTag(tag);
				if (!parsed) continue;
				const listed: ListedRelease = {
					...parsed,
					// A `-rc.N` tag is a pre-release whatever GitHub's flag says.
					isPrerelease: release.prerelease === true || parseVersion(parsed.version).pre !== '',
					publishedAt: release.published_at ? new Date(release.published_at).getTime() : Date.now(),
				};
				if (!search.wants(page, listed)) continue;
				if (known.has(tag)) {
					search.held(listed);
					continue;
				}
				const fetched = await fetchRelease(release, listed, headers);
				if (fetched) {
					releases.push(fetched);
					search.held(listed);
				}
			}
			if (!search.readsOn(page, listing.length)) break;
		}
		return { releases, prune: true, error: pageError };
	} catch (err) {
		return { releases, prune: false, error: err instanceof Error ? err.message : 'Unknown error' };
	}
}

export const refreshReleases = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx): Promise<null> => {
		const currentVersion = getOptional('OWLAT_VERSION') || 'dev';
		const headers = {
			Accept: 'application/vnd.github+json',
			'User-Agent': `owlat-selfhost/${currentVersion}`,
			'X-GitHub-Api-Version': '2022-11-28',
		};
		// Everything the walk learned, failure included, lands in one commit.
		const refresh = await walkReleases(ctx, headers);
		await ctx.runMutation(internal.desktop.refreshCommit.commitRefresh, refresh);
		return null;
	},
});

/**
 * Permission probe for `checkNow`. An action has no `ctx.db`, so it inherits its
 * caller's identity through this query to make the `settings:manage` decision —
 * the same shape `systemUpdates.checkForUpdates` uses for its platform-admin
 * check, against the gate self-hosters can actually reach.
 */
export const assertPolicyManager = internalQuery({
	args: {},
	handler: async (ctx): Promise<null> => {
		await requireOrgPermission(
			ctx,
			'settings:manage',
			'Only owners and admins can refresh desktop releases'
		);
		return null;
	},
});

export const checkNow = authedAction({
	args: {},
	handler: async (ctx): Promise<{ checkedAt: number | null; error: string | null }> => {
		// authz: `settings:manage` is enforced by the assertPolicyManager internal
		// query — an action cannot read the database to make the decision itself.
		await ctx.runQuery(internal.desktop.updates.assertPolicyManager, {});
		await ctx.runAction(internal.desktop.updates.refreshReleases, {});
		return await ctx.runQuery(internal.desktop.updates.getCheckStateInternal, {});
	},
});

// ── Public reads (the two Nitro routes) ──────────────────────────────────────

// public: the desktop updater fetches this from Rust with no session to present,
// and the answer — which signed GitHub release this instance offers — is already
// public on GitHub. Read-only, no identity, no writes.
// authz: no gate by design — the Rust updater has no session and the answer is already public on GitHub.
export const manifestForClient = publicQuery({
	args: {
		// `target` and `arch` are what Tauri substitutes into the endpoint URL.
		// The manifest is served verbatim and the CLIENT picks its platform key,
		// so they are not used for selection; they are here because the wire
		// contract has them and because the check-in counter (a later PR) counts
		// by them.
		target: v.string(),
		arch: v.string(),
		currentVersion: v.string(),
	},
	handler: async (ctx, args): Promise<{ manifest: string; version: string } | null> => {
		const policy = await readPolicy(ctx);
		const releases = await readReleases(ctx, activePin(policy));
		const decision = resolveDesktopUpdate({
			policy,
			releases: oneRowPerVersion(releases).map((release) => ({
				version: release.version ?? '',
				isPrerelease: release.isPrerelease,
				publishedAt: release.publishedAt,
				manifest: release.manifest ?? '',
			})),
			currentVersion: args.currentVersion,
			now: Date.now(),
		});
		if (decision.kind === 'none') return null;
		return { manifest: decision.release.manifest, version: decision.release.version };
	},
});

// public: the capability probe the desktop app hits before pointing its updater
// at this instance. Same class of data as `/api/instance-info` — the policy an
// operator set and the newest release already published on GitHub.
// authz: no gate by design — the updater capability probe answers before any session exists.
export const getPolicySummary = publicQuery({
	args: {},
	handler: async (ctx) => {
		const [policy, check] = await Promise.all([readPolicy(ctx), readCheckState(ctx)]);
		const releases = await readReleases(ctx, activePin(policy));
		const latest = newestRelease(oneRowPerVersion(releases), policy.channel);
		return {
			mode: policy.mode,
			channel: policy.channel,
			pinnedVersion: policy.pinnedVersion ?? null,
			requiredVersion: policy.requiredVersion ?? null,
			deferHours: policy.deferHours ?? 0,
			latestVersion: latest?.version ?? null,
			latestPublishedAt: latest?.publishedAt ?? null,
			// Whether anything is cached at all, on any channel. A null
			// `latestVersion` alone cannot tell "never refreshed" from "nothing on
			// this channel", and the app only goes around an instance for the first.
			hasCachedReleases: releases.length > 0,
			checkedAt: check?.checkedAt ?? null,
		};
	},
});

// all-members: the same policy is served unauthenticated by `getPolicySummary`;
// this adds only the refresh state an admin page shows. Writing it is gated.
export const getPolicy = authedQuery({
	args: {},
	handler: async (ctx) => {
		const [policy, check, lastChange] = await Promise.all([
			readPolicy(ctx),
			readCheckState(ctx),
			readLastChange(ctx),
		]);
		const pin = activePin(policy);
		return {
			policy,
			check: { checkedAt: check?.checkedAt ?? null, error: check?.error ?? null },
			lastChange,
			// False when the policy is pinned to a version the cache no longer
			// holds (a pin saved before pinned rows were exempt from the prune):
			// clients are offered nothing, and the admin page says so.
			pinCached: pin === undefined ? null : (await readVersionRows(ctx, pin)).length > 0,
		};
	},
});

export const listReleases = authedQuery({
	args: {},
	handler: async (ctx, _args, session) => {
		requirePermission(
			hasPermission(session.role, 'settings:manage'),
			'Only owners and admins can view cached desktop releases'
		);
		const releases = await readReleases(ctx, activePin(await readPolicy(ctx)));
		return releases
			.sort(
				(a, b) =>
					semverCompare(b.version ?? '', a.version ?? '') ||
					// Same version on both lines: list the one clients are served first.
					(preferCachedRelease(a, b) ? -1 : 1)
			)
			.map((release) => ({
				version: release.version ?? '',
				tag: release.tag ?? '',
				line: release.line ?? 'unified',
				isPrerelease: release.isPrerelease === true,
				publishedAt: release.publishedAt ?? 0,
				notes: release.notes ?? '',
			}));
	},
});

// ── Policy write ─────────────────────────────────────────────────────────────

export const updatePolicy = authedMutation({
	args: {
		mode: desktopUpdateModeValidator,
		channel: desktopUpdateChannelValidator,
		pinnedVersion: v.optional(v.string()),
		requiredVersion: v.optional(v.string()),
		deferHours: v.optional(v.number()),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'settings:manage'),
			'Only owners and admins can change the desktop update policy'
		);

		if (args.deferHours !== undefined) {
			if (
				!Number.isInteger(args.deferHours) ||
				args.deferHours < 0 ||
				args.deferHours > MAX_DEFER_HOURS
			) {
				throwInvalidInput(
					`A defer window must be a whole number of hours, 0 to ${MAX_DEFER_HOURS}`
				);
			}
		}
		if (args.requiredVersion !== undefined && !isValidTargetVersion(args.requiredVersion)) {
			throwInvalidInput('A required version must be a semver version such as 0.4.7');
		}

		let pinnedVersion: string | undefined;
		if (args.mode === 'pinned') {
			pinnedVersion = args.pinnedVersion;
			if (!pinnedVersion) {
				throwInvalidInput('Pinning needs a version to pin to');
			}
			// Read by key rather than out of the bounded list: a pin the prune kept
			// outside the rolling cache must stay re-savable.
			const [pinned] = oneRowPerVersion(await readVersionRows(ctx, pinnedVersion));
			if (!pinned) {
				// The UI can only offer cached versions; this is what stops a hand-
				// crafted call from pinning the fleet to a release nobody has.
				throwInvalidInput(`No cached desktop release for version ${pinnedVersion}`);
			}
			if (pinned.isPrerelease && args.channel !== 'prerelease') {
				// The resolver hides pre-releases on the stable channel before it
				// looks for the pin, so this combination would serve nothing to
				// anyone while the page says "pinned to …".
				throwInvalidInput(
					`${pinnedVersion} is a pre-release; pinning to it needs the prerelease channel`
				);
			}
		}

		// The whole object is replaced, so an omitted field CLEARS the stored one:
		// switching away from `pinned` drops the pin, and saving without a defer
		// window removes it rather than leaving a hold nobody asked for.
		const desktopUpdates = {
			mode: args.mode,
			channel: args.channel,
			pinnedVersion,
			requiredVersion: args.requiredVersion,
			deferHours: args.deferHours,
			updatedAt: Date.now(),
			updatedBy: session.userId,
		};

		const settingsId = await upsertInstanceSettings(ctx, { desktopUpdates });

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'settings.updated',
			resource: 'settings',
			resourceId: settingsId,
			detailsBlob: JSON.stringify({ desktopUpdates }),
		});
		return desktopUpdates;
	},
});
