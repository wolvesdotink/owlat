/**
 * System Updates — in-app update check & history.
 *
 * Flow:
 *   1. UI calls `checkForUpdates` action → fetches latest GitHub release,
 *      caches the result, returns it (with `updateAvailable` computed from
 *      current vs latest).
 *   2. UI calls `/api/system/update` (Nitro route in apps/web) to apply
 *      the update. That route records an `updateRun` doc via the
 *      `recordUpdateStart` / `recordUpdateFinish` mutations below.
 *   3. UI calls `listUpdateHistory` to render the history table.
 *
 * Gating: every function here is platform-admin only.
 *
 * WHY THE TWO RECORD MUTATIONS ARE PUBLIC, NOT INTERNAL
 * -----------------------------------------------------
 * They are called by a Nitro route in `apps/web`, i.e. over the deployment's
 * HTTP client API with the admin's session — and that API resolves PUBLIC
 * functions only. An `internal*` function is not addressable from it at all:
 * Convex answers `Could not find public function for
 * 'systemUpdates:recordUpdateStart'`, which is precisely how every in-app
 * update failed with a 500 before this changed. The `internal` reference was
 * re-tagged as public at the call site to satisfy the client's types, so
 * nothing but a real update on a real deployment could catch it.
 *
 * Being public means the auth floor has to be real, so each one runs the same
 * `requirePlatformAdmin` gate the route applies, and `initiatedBy` is stamped
 * from the authenticated admin instead of being accepted as an argument.
 */
import { v } from 'convex/values';
import { GITHUB_REPO_SLUG } from '@owlat/shared/releaseArtifacts';
import { semverCompare } from '@owlat/shared/semver';
import { getOptional } from './lib/env';
import { internalMutation, internalQuery } from './_generated/server';
import { authedAction, authedMutation, authedQuery } from './lib/authedFunctions';
import { internal } from './_generated/api';
import { requirePlatformAdmin } from './platformAdmin/platformAdmin';
import { updateStepResultValidator } from './lib/convexValidators';
import { requireAuthenticatedIdentity } from './lib/sessionOrganization';
import { throwForbidden, throwInternal, throwNotFound } from './_utils/errors';
import { successOrFailedValidator } from './lib/literalValidators';

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

// ── Update-run recording (platform-admin; called by /api/system/update) ──────

/**
 * Open the `updateRun` row for an update the admin has just triggered.
 *
 * Platform-admin only, and public on purpose — see the module header. Returns
 * the row id so the route can close the same row with `recordUpdateFinish`.
 *
 * ONE RUN AT A TIME
 * -----------------
 * Any run still `running` when this is called is retired to `superseded`
 * first, so the history can never show two updates in flight at once. It
 * regularly did: the happy path orphans its own row (the rollout's last step
 * recreates the container that would close it — see `getUnfinishedUpdate`),
 * and only the browser that started it can close it afterwards. Close that
 * tab and the row stays `running` forever, sitting above the next update's
 * row, which is then also `running`.
 *
 * Retiring beats refusing. The open row is usually the residue of an update
 * that already finished, so treating it as a live rollout and rejecting the
 * new one would wedge in-app updates permanently on exactly the instances
 * that already hit this. The updater sidecar is the real mutual exclusion:
 * it shells out with `execFileSync`, so a second `/update` cannot start until
 * the first has returned.
 */
export const recordUpdateStart = authedMutation({
	args: {
		versionFrom: v.string(),
		versionTo: v.string(),
	},
	handler: async (ctx, args) => {
		// The acting admin, not a caller-supplied id: an audit trail whose
		// actor field is an argument records whatever the caller claims.
		const admin = await requirePlatformAdmin(ctx);
		const initiatedBy = admin.authUserId;

		const startedAt = Date.now();

		const openRuns = await ctx.db
			.query('systemUpdates')
			.withIndex('by_kind_and_status', (q) => q.eq('kind', 'updateRun').eq('status', 'running'))
			.collect();
		for (const open of openRuns) {
			// No `finishedAt`: we do not know when that rollout ended, only that
			// the instance has moved on from it. Stamping "now" would make the
			// history's duration column report the gap between two updates as
			// the length of the first one — hours, for a four-minute rollout.
			await ctx.db.patch(open._id, {
				status: 'superseded',
				// Not `failed`, and the message says why: this run's rollout may
				// have worked. What is true is that nobody is left to report it.
				error: `Superseded by the update to ${args.versionTo}`,
			});
			// eslint-disable-next-line no-console
			console.info(
				JSON.stringify({
					event: 'update_superseded',
					runId: open._id,
					versionFrom: open.versionFrom,
					versionTo: open.versionTo,
					supersededByVersionTo: args.versionTo,
					timestamp: new Date(startedAt).toISOString(),
				})
			);
		}

		const runId = await ctx.db.insert('systemUpdates', {
			kind: 'updateRun',
			versionFrom: args.versionFrom,
			versionTo: args.versionTo,
			startedAt,
			status: 'running',
			initiatedBy,
		});

		// Structured log for external log sinks. stdout JSON lines are
		// trivially scraped by Loki/DataDog/Vector — gives us a time-
		// correlated record of every update attempt without coupling to a
		// specific provider.
		// eslint-disable-next-line no-console
		console.info(
			JSON.stringify({
				event: 'update_start',
				runId: runId,
				versionFrom: args.versionFrom,
				versionTo: args.versionTo,
				initiatedBy,
				startedAt,
				timestamp: new Date(startedAt).toISOString(),
			})
		);
		return runId;
	},
});

/**
 * Close an `updateRun` row with the updater sidecar's verdict and step log.
 *
 * Platform-admin only, and public on purpose — see the module header. The id
 * is checked to be an `updateRun` row: `systemUpdates` also holds the
 * singleton `latestCheck` document, and patching THAT with a run status would
 * corrupt the update-check cache the dashboard reads.
 */
export const recordUpdateFinish = authedMutation({
	args: {
		runId: v.id('systemUpdates'),
		status: successOrFailedValidator,
		steps: v.optional(updateStepResultValidator),
		error: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requirePlatformAdmin(ctx);

		const existing = await ctx.db.get(args.runId);
		if (!existing || existing.kind !== 'updateRun') {
			throwNotFound('update run');
		}

		// A later update already retired this row (see `recordUpdateStart`).
		// `superseded` is terminal on purpose: the late verdict arriving here
		// is from a rollout the instance has since moved past, and writing it
		// back would put a second `success` above the run that replaced it.
		if (existing.status === 'superseded') {
			return;
		}

		const finishedAt = Date.now();
		await ctx.db.patch(args.runId, {
			finishedAt,
			status: args.status,
			steps: args.steps,
			error: args.error,
		});

		// Pairs with recordUpdateStart's structured event so a log sink can
		// compute duration + success rate without running a Convex query.
		// Include run metadata so each line is self-contained (no join
		// needed). Read from the pre-patch document — the patch touches none
		// of these fields, so re-reading the row would only cost a second read.
		const durationMs = existing.startedAt ? finishedAt - existing.startedAt : undefined;
		// eslint-disable-next-line no-console
		console.info(
			JSON.stringify({
				event: 'update_finish',
				runId: args.runId,
				versionFrom: existing.versionFrom,
				versionTo: existing.versionTo,
				status: args.status,
				durationMs,
				initiatedBy: existing.initiatedBy,
				error: args.error,
				timestamp: new Date(finishedAt).toISOString(),
			})
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

/**
 * The `updateRun` row that is still open, if there is one.
 *
 * Every successful in-app update orphans its own row. `recordUpdateFinish` is
 * called by the Nitro route that dispatched the update, and the update's last
 * step recreates the container that route is running in — so on the happy path
 * the process that would close the row is gone before the sidecar's answer gets
 * back to it, and the run stays `running` in the history table forever.
 *
 * The browser outlives all of it, and its health poller is the only thing that
 * ever learns how the run ended: it watches for the target version to come up.
 * This query hands it the row to close. Only the NEWEST run is considered —
 * an older one is not something a later update's poller can honestly speak
 * for. Older runs cannot be `running` anyway: `recordUpdateStart` retires
 * every open row before opening its own.
 */
export const getUnfinishedUpdate = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requirePlatformAdmin(ctx);
		const [newest] = await ctx.db
			.query('systemUpdates')
			.withIndex('by_kind_and_startedAt', (q) => q.eq('kind', 'updateRun'))
			.order('desc')
			.take(1);
		if (!newest || newest.status !== 'running') return null;
		return { runId: newest._id, versionTo: newest.versionTo ?? null };
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
		const cached = await ctx.runQuery(internal.systemUpdates.getLatestCheckInternal);
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
