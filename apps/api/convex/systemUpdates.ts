/**
 * System Updates — in-app update check & history.
 *
 * Flow:
 *   1. UI calls `checkForUpdates` (in the `systemUpdatesReleaseCheck.ts`
 *      sibling) → fetches the latest GitHub release and caches it;
 *      `getLatestRelease` below reads that cache back.
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
import { authedMutation, authedQuery } from './lib/authedFunctions';
import { requirePlatformAdmin } from './platformAdmin/platformAdmin';
import { updateStepResultValidator } from './lib/convexValidators';
import { throwNotFound } from './_utils/errors';
import { successOrFailedValidator } from './lib/literalValidators';

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
