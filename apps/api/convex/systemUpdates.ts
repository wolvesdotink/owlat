/**
 * System Updates — in-app update check & history.
 *
 * Flow:
 *   1. UI calls `checkForUpdates` action → fetches latest GitHub release,
 *      caches the result, returns it (with `updateAvailable` computed from
 *      current vs latest).
 *   2. UI calls `/api/system/update` (Nitro route in apps/web) to apply
 *      the update. That route records an `updateRun` doc via
 *      `recordUpdateStart` / `recordUpdateFinish` internal mutations.
 *   3. UI calls `listUpdateHistory` to render the history table.
 *
 * Gating: all UI-facing queries/actions are platform-admin only. Internal
 * mutations are trusted because they're only callable from server-side
 * routes that have already verified admin.
 */
import { v } from 'convex/values';
import { getOptional } from './lib/env';
import {
	internalMutation,
	internalQuery,
} from './_generated/server';
import { authedAction, authedQuery } from './lib/authedFunctions';
import { internal } from './_generated/api';
import { requirePlatformAdmin } from "./platformAdmin/platformAdmin";
import { updateStepResultValidator } from './lib/convexValidators';
import { requireAuthenticatedIdentity } from './lib/sessionOrganization';
import { throwForbidden, throwInternal } from './_utils/errors';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compare two semver strings.
 * Returns:
 *   +1 if a > b   (e.g. "1.2.4" > "1.2.3")
 *    0 if a == b
 *   -1 if a < b
 *
 * Tolerant of pre-release suffixes: a pre-release compares LESS than the
 * equivalent release ("1.2.0-beta.1" < "1.2.0"). Between two pre-releases,
 * the suffix is compared lexicographically.
 */
export function semverCompare(a: string, b: string): number {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	for (let i = 0; i < 3; i++) {
		const av = pa.parts[i] ?? 0;
		const bv = pb.parts[i] ?? 0;
		if (av !== bv) {
			return av > bv ? 1 : -1;
		}
	}
	// Pre-release < release (empty string beats any suffix)
	if (pa.pre === '' && pb.pre === '') return 0;
	if (pa.pre === '') return 1;
	if (pb.pre === '') return -1;
	return pa.pre > pb.pre ? 1 : pa.pre < pb.pre ? -1 : 0;
}

function parseVersion(v: string): { parts: [number, number, number]; pre: string } {
	const clean = v.replace(/^v/, '').trim();
	const [main = '', pre = ''] = clean.split('-');
	const parts = main.split('.').map((p) => parseInt(p, 10) || 0);
	return {
		parts: [parts[0] || 0, parts[1] || 0, parts[2] || 0] as [number, number, number],
		pre,
	};
}

const CHECK_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/wolvesdotink/owlat/releases/latest';

// ── Internal mutations / queries (cache + history) ───────────────────────────

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

export const recordUpdateStart = internalMutation({
	args: {
		versionFrom: v.string(),
		versionTo: v.string(),
		initiatedBy: v.string(),
	},
	handler: async (ctx, args) => {
		const startedAt = Date.now();
		const runId = await ctx.db.insert('systemUpdates', {
			kind: 'updateRun',
			versionFrom: args.versionFrom,
			versionTo: args.versionTo,
			startedAt,
			status: 'running',
			initiatedBy: args.initiatedBy,
		});

		// P4.3: structured log for external log sinks. stdout JSON lines
		// are trivially scraped by Loki/DataDog/Vector — gives us a time-
		// correlated record of every update attempt without coupling to a
		// specific provider.
		// eslint-disable-next-line no-console
		console.info(
			JSON.stringify({
				event: 'update_start',
				runId: String(runId),
				versionFrom: args.versionFrom,
				versionTo: args.versionTo,
				initiatedBy: args.initiatedBy,
				startedAt,
				timestamp: new Date(startedAt).toISOString(),
			}),
		);
		return runId;
	},
});

export const recordUpdateFinish = internalMutation({
	args: {
		runId: v.id('systemUpdates'),
		status: v.union(v.literal('success'), v.literal('failed')),
		steps: v.optional(updateStepResultValidator),
		error: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const finishedAt = Date.now();
		await ctx.db.patch(args.runId, {
			finishedAt,
			status: args.status,
			steps: args.steps,
			error: args.error,
		});

		// P4.3: pair with recordUpdateStart's structured event so a log
		// sink can compute duration + success rate without running a
		// Convex query. Include run metadata so each line is self-
		// contained (no join needed).
		const run = await ctx.db.get(args.runId);
		const durationMs = run?.startedAt ? finishedAt - run.startedAt : undefined;
		// eslint-disable-next-line no-console
		console.info(
			JSON.stringify({
				event: 'update_finish',
				runId: String(args.runId),
				versionFrom: run?.versionFrom,
				versionTo: run?.versionTo,
				status: args.status,
				durationMs,
				initiatedBy: run?.initiatedBy,
				error: args.error,
				timestamp: new Date(finishedAt).toISOString(),
			}),
		);
	},
});

// ── Public queries ───────────────────────────────────────────────────────────

export const getLatestRelease = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requirePlatformAdmin(ctx);

		const cached = await ctx.db
			.query('systemUpdates')
			.withIndex('by_kind_and_checkedAt', (q) => q.eq('kind', 'latestCheck'))
			.order('desc')
			.first();

		if (!cached) return null;

		return {
			latestVersion: cached.latestVersion,
			releaseNotes: cached.releaseNotes,
			publishedAt: cached.publishedAt,
			checkedAt: cached.checkedAt,
			error: cached.error,
		};
	},
});

export const listUpdateHistory = authedQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		await requirePlatformAdmin(ctx);
		const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
		return await ctx.db
			.query('systemUpdates')
			.withIndex('by_kind_and_startedAt', (q) => q.eq('kind', 'updateRun'))
			.order('desc')
			.take(limit);
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
		const isAdmin = await ctx.runQuery(internal.platformAdmin.platformAdmin.isPlatformAdminByUserId, {
			authUserId: identity.subject,
		});
		if (!isAdmin) {
			throwForbidden('Platform admin access required');
		}

		const currentVersion = getOptional('OWLAT_VERSION') || 'dev';

		// Read cache; return stale if fresh and !force
		const cached = await ctx.runQuery(internal.systemUpdates.getLatestCheckInternal);
		const now = Date.now();

		if (!args.force && cached?.checkedAt && (now - cached.checkedAt) < CHECK_CACHE_TTL_MS) {
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
					'Accept': 'application/vnd.github+json',
					'User-Agent': `owlat-selfhost/${currentVersion}`,
					'X-GitHub-Api-Version': '2022-11-28',
				},
			});

			if (resp.status === 403 || resp.status === 429) {
				// Rate-limited — return cache if we have it
				await ctx.runMutation(internal.systemUpdates.cacheCheckFailure, {
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

			const release = await resp.json() as {
				tag_name?: string;
				body?: string;
				published_at?: string;
			};

			const tag = release.tag_name || '';
			const latestVersion = tag.replace(/^v/, '');
			const releaseNotes = release.body || '';
			const publishedAt = release.published_at ? new Date(release.published_at).getTime() : now;

			if (!latestVersion) {
				throwInternal('GitHub release has no tag_name');
			}

			await ctx.runMutation(internal.systemUpdates.cacheLatestRelease, {
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
			await ctx.runMutation(internal.systemUpdates.cacheCheckFailure, {
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
