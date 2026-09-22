/**
 * System Updates — polling GitHub for the latest release, and caching it.
 *
 * The other half of the feature lives in `systemUpdates.ts`, which records the
 * history of updates this instance actually applied. This file is the read
 * side: `checkForUpdates` fetches the newest unified `v*` release, caches it
 * on the `kind='latestCheck'` singleton of the `systemUpdates` table, and
 * answers whether it is newer than what this instance is running. The public
 * query that reads that cache back — `getLatestRelease` — stays next to the
 * history it is rendered beside.
 *
 * Split out of `systemUpdates.ts` when it crossed the ~500 LOC cap in
 * apps/api/convex/CONVENTIONS.md. Release polling is the separable half: it
 * talks to GitHub, owns the cache TTL and the tag grammar, and shares nothing
 * with the run recorder but the table.
 *
 * Gating: platform-admin only, like everything in the pair.
 */
import { v } from 'convex/values';
import { GITHUB_REPO_SLUG } from '@owlat/shared/releaseArtifacts';
import { semverCompare } from '@owlat/shared/semver';
import { getOptional } from './lib/env';
import { internalMutation, internalQuery } from './_generated/server';
import { authedAction } from './lib/authedFunctions';
import { internal } from './_generated/api';
import { requireAuthenticatedIdentity } from './lib/sessionOrganization';
import { throwForbidden, throwInternal } from './_utils/errors';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the semver string from a GitHub release tag, but ONLY for the
 * unified release line (bare `vX.Y.Z` / `vX.Y.Z-pre`).
 *
 * The repo publishes three release lines from separate pipelines — the unified
 * `v*` release (server + desktop + install assets) plus target-only
 * `server-v*` and `desktop-v*` releases. Only the unified `v*` line is marked
 * `--latest`, so `/releases/latest` normally returns it. This guard is defence
 * in depth: a target-prefixed tag such as `server-v0.2.1` must be ignored
 * rather than mis-parsed to `0.0.0` (which would hide a real available update).
 *
 * Returns the bare version (leading `v` stripped) or `null` if the tag is not
 * a bare `vX.Y.Z` release tag.
 */
export function parseReleaseTag(tag: string): string | null {
	if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
		return null;
	}
	return tag.replace(/^v/, '');
}

const CHECK_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const GITHUB_RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO_SLUG}/releases/latest`;

// ── Internal mutations / queries (release-check cache) ───────────────────────

export const cacheLatestRelease = internalMutation({
	args: {
		latestVersion: v.string(),
		releaseNotes: v.string(),
		publishedAt: v.number(),
		error: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		// Upsert single "latestCheck" doc per instance
		const existing = await ctx.db
			.query('systemUpdates')
			.withIndex('by_kind_and_checkedAt', (q) => q.eq('kind', 'latestCheck'))
			.order('desc')
			.first();

		const patch = {
			latestVersion: args.latestVersion,
			releaseNotes: args.releaseNotes,
			publishedAt: args.publishedAt,
			checkedAt: Date.now(),
			error: args.error,
		};

		if (existing) {
			await ctx.db.patch(existing._id, patch);
			return existing._id;
		}
		return await ctx.db.insert('systemUpdates', {
			kind: 'latestCheck',
			...patch,
		});
	},
});

export const cacheCheckFailure = internalMutation({
	args: { error: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('systemUpdates')
			.withIndex('by_kind_and_checkedAt', (q) => q.eq('kind', 'latestCheck'))
			.order('desc')
			.first();

		if (existing) {
			await ctx.db.patch(existing._id, {
				checkedAt: Date.now(),
				error: args.error,
			});
			return existing._id;
		}
		return await ctx.db.insert('systemUpdates', {
			kind: 'latestCheck',
			checkedAt: Date.now(),
			error: args.error,
		});
	},
});

export const getLatestCheckInternal = internalQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db
			.query('systemUpdates')
			.withIndex('by_kind_and_checkedAt', (q) => q.eq('kind', 'latestCheck'))
			.order('desc')
			.first();
	},
});

// ── Check action ─────────────────────────────────────────────────────────────

type CheckForUpdatesResult = {
	latestVersion: string | null;
	currentVersion: string;
	updateAvailable: boolean;
	releaseNotes: string | null;
	publishedAt: number | null;
	checkedAt: number;
	error: string | null;
};

export const checkForUpdates = authedAction({
	args: { force: v.optional(v.boolean()) },
	returns: v.object({
		latestVersion: v.union(v.string(), v.null()),
		currentVersion: v.string(),
		updateAvailable: v.boolean(),
		releaseNotes: v.union(v.string(), v.null()),
		publishedAt: v.union(v.number(), v.null()),
		checkedAt: v.number(),
		error: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args): Promise<CheckForUpdatesResult> => {
		// Action context — can't call requirePlatformAdmin (needs QueryCtx).
		// Verify admin via internal query instead.
		const identity = await requireAuthenticatedIdentity(ctx);
		const isAdmin = await ctx.runQuery(
			internal.platformAdmin.platformAdmin.isPlatformAdminByUserId,
			{
				authUserId: identity.subject,
			}
		);
		if (!isAdmin) {
			throwForbidden('Platform admin access required');
		}

		const currentVersion = getOptional('OWLAT_VERSION') || 'dev';

		// Read cache; return stale if fresh and !force
		const cached = await ctx.runQuery(internal.systemUpdatesReleaseCheck.getLatestCheckInternal);
		const now = Date.now();

		if (!args.force && cached?.checkedAt && now - cached.checkedAt < CHECK_CACHE_TTL_MS) {
			const latestVersion = cached.latestVersion ?? null;
			return {
				latestVersion,
				currentVersion,
				updateAvailable: latestVersion ? isNewer(latestVersion, currentVersion) : false,
				releaseNotes: cached.releaseNotes ?? null,
				publishedAt: cached.publishedAt ?? null,
				checkedAt: cached.checkedAt,
				error: cached.error ?? null,
			};
		}

		// Poll GitHub API
		try {
			const resp = await fetch(GITHUB_RELEASES_URL, {
				headers: {
					Accept: 'application/vnd.github+json',
					'User-Agent': `owlat-selfhost/${currentVersion}`,
					'X-GitHub-Api-Version': '2022-11-28',
				},
			});

			if (resp.status === 403 || resp.status === 429) {
				// Rate-limited — return cache if we have it
				await ctx.runMutation(internal.systemUpdatesReleaseCheck.cacheCheckFailure, {
					error: 'rate_limited',
				});
				const latestVersion = cached?.latestVersion ?? null;
				return {
					latestVersion,
					currentVersion,
					updateAvailable: latestVersion ? isNewer(latestVersion, currentVersion) : false,
					releaseNotes: cached?.releaseNotes ?? null,
					publishedAt: cached?.publishedAt ?? null,
					checkedAt: now,
					error: 'rate_limited',
				};
			}

			if (!resp.ok) {
				throwInternal(`GitHub API returned ${resp.status}`);
			}

			const release = (await resp.json()) as {
				tag_name?: string;
				body?: string;
				published_at?: string;
			};

			const tag = release.tag_name || '';
			const latestVersion = parseReleaseTag(tag);
			const releaseNotes = release.body || '';
			const publishedAt = release.published_at ? new Date(release.published_at).getTime() : now;

			if (!latestVersion) {
				// Not a bare `vX.Y.Z` tag from the unified release line (e.g. a
				// target-only `server-v*` / `desktop-v*` release, or a missing
				// tag). Ignore it: keep any cached version and report no update
				// rather than mis-parsing the tag to 0.0.0.
				const cachedVersion = cached?.latestVersion ?? null;
				return {
					latestVersion: cachedVersion,
					currentVersion,
					updateAvailable: cachedVersion ? isNewer(cachedVersion, currentVersion) : false,
					releaseNotes: cached?.releaseNotes ?? null,
					publishedAt: cached?.publishedAt ?? null,
					checkedAt: now,
					error: null,
				};
			}

			await ctx.runMutation(internal.systemUpdatesReleaseCheck.cacheLatestRelease, {
				latestVersion,
				releaseNotes,
				publishedAt,
			});

			return {
				latestVersion,
				currentVersion,
				updateAvailable: isNewer(latestVersion, currentVersion),
				releaseNotes,
				publishedAt,
				checkedAt: now,
				error: null,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Unknown error';
			await ctx.runMutation(internal.systemUpdatesReleaseCheck.cacheCheckFailure, {
				error: message,
			});

			const latestVersion = cached?.latestVersion ?? null;
			return {
				latestVersion,
				currentVersion,
				updateAvailable: latestVersion ? isNewer(latestVersion, currentVersion) : false,
				releaseNotes: cached?.releaseNotes ?? null,
				publishedAt: cached?.publishedAt ?? null,
				checkedAt: now,
				error: message,
			};
		}
	},
});

/**
 * True if `remote` is strictly newer than `local`. 'dev' (unreleased local
 * build) is always treated as "no update available" because we don't know
 * if the dev build is ahead or behind. Non-semver local versions are also
 * skipped.
 */
function isNewer(remote: string, local: string): boolean {
	if (local === 'dev' || local === 'unknown' || !/^\d+\.\d+\.\d+/.test(local)) {
		return false;
	}
	return semverCompare(remote, local) > 0;
}
