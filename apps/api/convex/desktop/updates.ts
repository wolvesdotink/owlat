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
 *      one's `latest.json`, validates it, and caches it VERBATIM.
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
import { internalAction, internalMutation, internalQuery } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { authedMutation, authedQuery, authedAction, publicQuery } from '../lib/authedFunctions';
import { getOptional } from '../lib/env';
import { recordAuditLog } from '../lib/auditLog';
import { hasPermission, requireOrgPermission, requirePermission } from '../lib/sessionOrganization';
import { throwInvalidInput } from '../_utils/errors';
import {
	desktopUpdateChannelValidator,
	desktopUpdateModeValidator,
} from '../lib/literalValidators';
import { isValidManifest, parseDesktopReleaseTag, type GithubRelease } from './releaseManifest';
import {
	DEFAULT_DESKTOP_UPDATE_POLICY,
	DESKTOP_RELEASE_CACHE_LIMIT,
	MAX_DEFER_HOURS,
	newestRelease,
	oneRowPerVersion,
	preferCachedRelease,
	resolveDesktopUpdate,
	type DesktopUpdatePolicy,
} from './updateResolver';

// ── Constants ────────────────────────────────────────────────────────────────

const GITHUB_RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO_SLUG}/releases?per_page=30`;

/** Release bodies are shown on the admin page; clamp what we store. */
const NOTES_MAX_CHARS = 8000;

// ── Reads shared by the public queries ───────────────────────────────────────

async function readPolicy(ctx: QueryCtx): Promise<DesktopUpdatePolicy> {
	const settings = await ctx.db.query('instanceSettings').first();
	const stored = settings?.desktopUpdates;
	if (!stored) return DEFAULT_DESKTOP_UPDATE_POLICY;
	return {
		mode: stored.mode,
		channel: stored.channel,
		pinnedVersion: stored.pinnedVersion,
		requiredVersion: stored.requiredVersion,
		deferHours: stored.deferHours,
	};
}

/**
 * Every cached release. The refresh prunes to `DESKTOP_RELEASE_CACHE_LIMIT`, so
 * the double is headroom for the moment mid-refresh when new rows are in and the
 * prune has not run yet — the index orders by version STRING, so a short read
 * could otherwise miss exactly the newest release.
 */
async function readReleases(ctx: QueryCtx): Promise<Doc<'desktopReleases'>[]> {
	const rows = await ctx.db
		.query('desktopReleases')
		.withIndex('by_kind_and_version', (q) => q.eq('kind', 'release'))
		.take(DESKTOP_RELEASE_CACHE_LIMIT * 2);
	return rows.filter((row) => typeof row.version === 'string' && typeof row.manifest === 'string');
}

/**
 * Who last wrote the policy and when, resolved to a name for the audit line on
 * the admin page. Null before anyone has touched it — a fresh instance runs on
 * the default policy, which nobody chose.
 */
async function readLastChange(ctx: QueryCtx): Promise<{ at: number; by: string | null } | null> {
	const settings = await ctx.db.query('instanceSettings').first();
	const stored = settings?.desktopUpdates;
	if (!stored) return null;
	const profile = await ctx.db
		.query('userProfiles')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', stored.updatedBy))
		.first();
	return { at: stored.updatedAt, by: profile?.name || profile?.email || null };
}

async function readCheckState(ctx: QueryCtx): Promise<Doc<'desktopReleases'> | null> {
	return await ctx.db
		.query('desktopReleases')
		.withIndex('by_kind_and_checkedAt', (q) => q.eq('kind', 'latestCheck'))
		.order('desc')
		.first();
}

// ── Internal cache plumbing ──────────────────────────────────────────────────

export const listCachedTagsInternal = internalQuery({
	args: {},
	handler: async (ctx): Promise<string[]> => {
		const rows = await ctx.db
			.query('desktopReleases')
			.withIndex('by_kind_and_version', (q) => q.eq('kind', 'release'))
			.take(DESKTOP_RELEASE_CACHE_LIMIT);
		return rows.map((row) => row.tag ?? '').filter((tag) => tag.length > 0);
	},
});

export const getCheckStateInternal = internalQuery({
	args: {},
	handler: async (ctx) => {
		const row = await readCheckState(ctx);
		return { checkedAt: row?.checkedAt ?? null, error: row?.error ?? null };
	},
});

export const cacheRelease = internalMutation({
	args: {
		tag: v.string(),
		version: v.string(),
		line: v.union(v.literal('unified'), v.literal('desktop')),
		isPrerelease: v.boolean(),
		publishedAt: v.number(),
		notes: v.string(),
		manifest: v.string(),
	},
	handler: async (ctx, args): Promise<Id<'desktopReleases'>> => {
		// Keyed by tag, not version: `refreshReleases` decides what is new by tag,
		// and two release lines can legitimately publish the same version.
		const existing = await ctx.db
			.query('desktopReleases')
			.withIndex('by_kind_and_tag', (q) => q.eq('kind', 'release').eq('tag', args.tag))
			.first();
		const row = { kind: 'release' as const, ...args, fetchedAt: Date.now() };
		if (existing) {
			await ctx.db.patch(existing._id, row);
			return existing._id;
		}
		return await ctx.db.insert('desktopReleases', row);
	},
});

export const recordCheck = internalMutation({
	args: { error: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const existing = await readCheckState(ctx);
		const patch = { checkedAt: Date.now(), error: args.error };
		if (existing) {
			await ctx.db.patch(existing._id, patch);
			return;
		}
		await ctx.db.insert('desktopReleases', { kind: 'latestCheck', ...patch });
	},
});

/** Keep the newest `DESKTOP_RELEASE_CACHE_LIMIT` releases; drop the rest. */
export const pruneReleases = internalMutation({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db
			.query('desktopReleases')
			.withIndex('by_kind_and_version', (q) => q.eq('kind', 'release'))
			.take(DESKTOP_RELEASE_CACHE_LIMIT * 4);
		if (rows.length <= DESKTOP_RELEASE_CACHE_LIMIT) return;
		const doomed = rows
			.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
			.slice(DESKTOP_RELEASE_CACHE_LIMIT);
		for (const row of doomed) {
			await ctx.db.delete(row._id);
		}
	},
});

// ── Refresh (cron + admin button) ────────────────────────────────────────────

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

		try {
			const resp = await fetch(GITHUB_RELEASES_URL, { headers });
			if (resp.status === 403 || resp.status === 429) {
				// Rate-limited: record it and leave the cache exactly as it was, so
				// clients keep being served what we already know about.
				await ctx.runMutation(internal.desktop.updates.recordCheck, { error: 'rate_limited' });
				return null;
			}
			if (!resp.ok) {
				await ctx.runMutation(internal.desktop.updates.recordCheck, {
					error: `GitHub API returned ${resp.status}`,
				});
				return null;
			}

			const releases = (await resp.json()) as GithubRelease[];
			const known = new Set(
				await ctx.runQuery(internal.desktop.updates.listCachedTagsInternal, {})
			);

			for (const release of Array.isArray(releases) ? releases : []) {
				const tag = release.tag_name ?? '';
				if (release.draft || known.has(tag)) continue;
				const parsed = parseDesktopReleaseTag(tag);
				if (!parsed) continue;

				const manifestResp = await fetch(`${RELEASE_DOWNLOAD_BASE}/${tag}/latest.json`, {
					headers: { 'User-Agent': headers['User-Agent'] },
				});
				// A release with no `latest.json` shipped no desktop bundle (the
				// server-only line, or a unified release that predates the updater).
				if (!manifestResp.ok) continue;

				const manifest = await manifestResp.text();
				if (!isValidManifest(manifest, parsed.version)) {
					console.warn(`desktop updates: rejected manifest for ${tag} (failed validation)`);
					continue;
				}

				await ctx.runMutation(internal.desktop.updates.cacheRelease, {
					tag,
					version: parsed.version,
					line: parsed.line,
					// A `-rc.N` tag is a pre-release whatever GitHub's flag says.
					isPrerelease: release.prerelease === true || parseVersion(parsed.version).pre !== '',
					publishedAt: release.published_at ? new Date(release.published_at).getTime() : Date.now(),
					notes: (release.body ?? '').slice(0, NOTES_MAX_CHARS),
					manifest,
				});
			}

			await ctx.runMutation(internal.desktop.updates.pruneReleases, {});
			await ctx.runMutation(internal.desktop.updates.recordCheck, {});
		} catch (err) {
			await ctx.runMutation(internal.desktop.updates.recordCheck, {
				error: err instanceof Error ? err.message : 'Unknown error',
			});
		}
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
		const [policy, releases] = await Promise.all([readPolicy(ctx), readReleases(ctx)]);
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
		const [policy, releases, check] = await Promise.all([
			readPolicy(ctx),
			readReleases(ctx),
			readCheckState(ctx),
		]);
		const latest = newestRelease(oneRowPerVersion(releases), policy.channel);
		return {
			mode: policy.mode,
			channel: policy.channel,
			pinnedVersion: policy.pinnedVersion ?? null,
			requiredVersion: policy.requiredVersion ?? null,
			deferHours: policy.deferHours ?? 0,
			latestVersion: latest?.version ?? null,
			latestPublishedAt: latest?.publishedAt ?? null,
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
		return {
			policy,
			check: { checkedAt: check?.checkedAt ?? null, error: check?.error ?? null },
			lastChange,
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
		const releases = await readReleases(ctx);
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
			const releases = await readReleases(ctx);
			const pinned = releases.find((release) => release.version === pinnedVersion);
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

		const settings = await ctx.db.query('instanceSettings').first();
		let settingsId: Id<'instanceSettings'>;
		if (settings) {
			settingsId = settings._id;
			await ctx.db.patch(settingsId, { desktopUpdates, updatedAt: Date.now() });
		} else {
			settingsId = await ctx.db.insert('instanceSettings', {
				desktopUpdates,
				createdAt: Date.now(),
			});
		}

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
