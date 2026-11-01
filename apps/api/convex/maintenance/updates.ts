/**
 * System Updates — in-app update check & history.
 *
 * Flow:
 *   1. UI calls `checkForUpdates` (in the `releaseCheck.ts`
 *      sibling) → fetches the latest GitHub release and caches it;
 *      `getLatestRelease` below reads that cache back.
 *   2. UI calls `/api/system/update` (Nitro route in apps/web) to apply
 *      the update. That route records an `updateRun` doc via the
 *      `recordUpdateStart` / `recordUpdateFinish` mutations below.
 *   3. UI calls `listUpdateHistory` to render the history table.
 *
 * Gating: every function here is platform-admin only, except
 * `getRolloutActivity`, which tells any member no more than when the running
 * update last showed activity.
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
 * Being public means the auth floor has to be real, so each one is a
 * `platformAdminMutation`, the same platform-admin gate the route applies, and
 * `initiatedBy` is stamped from the authenticated admin instead of being
 * accepted as an argument.
 */
import { v, type ObjectType } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { platformAdminMutation, platformAdminQuery, publicQuery } from '../lib/authedFunctions';
import type { PlatformAdminContext } from '../lib/platformAdminAccess';
import { isActiveOrgMember } from '../lib/sessionOrganization';
import { updateStepResultValidator } from '../lib/convexValidators';
import { throwNotFound } from '../_utils/errors';
import { successOrFailedValidator } from '../lib/literalValidators';

// ── Update-run recording (platform-admin; called by /api/system/update) ──────

/** The note on a run `recordUpdateStart` retired for the update to `versionTo`. */
function supersededNote(versionTo: string | undefined): string {
	return `Superseded by the update to ${versionTo}`;
}

/** `recordUpdateStart`'s arguments. */
export const updateStartArgs = {
	versionFrom: v.string(),
	versionTo: v.string(),
};

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
export const recordUpdateStart = platformAdminMutation({
	args: updateStartArgs,
	handler: async (ctx, args, admin) => await openUpdateRun(ctx, args, admin),
});

/** The body of `recordUpdateStart`. */
export async function openUpdateRun(
	ctx: MutationCtx,
	args: ObjectType<typeof updateStartArgs>,
	admin: PlatformAdminContext
) {
	// The acting admin, not a caller-supplied id: an audit trail whose
	// actor field is an argument records whatever the caller claims.
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
			error: supersededNote(args.versionTo),
		});
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
}

/** `recordUpdateFinish`'s arguments. */
export const updateFinishArgs = {
	runId: v.id('systemUpdates'),
	status: successOrFailedValidator,
	steps: v.optional(updateStepResultValidator),
	error: v.optional(v.string()),
};

/**
 * Close an `updateRun` row with the updater sidecar's verdict and step log.
 *
 * Platform-admin only, and public on purpose — see the module header. The id
 * is checked to be an `updateRun` row: `systemUpdates` also holds the
 * singleton `latestCheck` document, and patching THAT with a run status would
 * corrupt the update-check cache the dashboard reads.
 */
export const recordUpdateFinish = platformAdminMutation({
	args: updateFinishArgs,
	handler: async (ctx, args) => await closeUpdateRun(ctx, args),
});

/** The body of `recordUpdateFinish`. */
export async function closeUpdateRun(ctx: MutationCtx, args: ObjectType<typeof updateFinishArgs>) {
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
}

/** `withdrawUpdateStart`'s arguments. */
export const withdrawUpdateArgs = {
	runId: v.id('systemUpdates'),
};

/**
 * Take back the `updateRun` row of an update the updater refused to start:
 * another rollout held it (409) or its rate limit did (429). Nothing was
 * changed, so there is no run to record, and a `failed` row would report an
 * update that never ran as broken.
 *
 * Opening the row retired the run that was still open (`recordUpdateStart`),
 * which is typically the very rollout the refusal was about. If the run just
 * before this one was retired by it, it goes back to `running`, so its own
 * verdict can still close it.
 *
 * Platform-admin only, and public on purpose — see the module header.
 */
export const withdrawUpdateStart = platformAdminMutation({
	args: withdrawUpdateArgs,
	handler: async (ctx, args) => await withdrawUpdateRun(ctx, args),
});

/** The body of `withdrawUpdateStart`. */
export async function withdrawUpdateRun(
	ctx: MutationCtx,
	args: ObjectType<typeof withdrawUpdateArgs>
) {
	const run = await ctx.db.get(args.runId);
	if (!run || run.kind !== 'updateRun') {
		throwNotFound('update run');
	}
	// A run with a verdict, or one a later update already retired, is history.
	if (run.status !== 'running') return;
	await ctx.db.delete(run._id);

	const startedAt = run.startedAt;
	if (startedAt === undefined) return;
	const previous = await ctx.db
		.query('systemUpdates')
		.withIndex('by_kind_and_startedAt', (q) => q.eq('kind', 'updateRun').lt('startedAt', startedAt))
		.order('desc')
		.first();
	if (previous?.status === 'superseded' && previous.error === supersededNote(run.versionTo)) {
		await ctx.db.patch(previous._id, { status: 'running', error: undefined });
	}
}

// ── Public queries ───────────────────────────────────────────────────────────

export const getLatestRelease = platformAdminQuery({
	args: {},
	handler: async (ctx) => await readLatestRelease(ctx),
});

/** The body of `getLatestRelease`. */
export async function readLatestRelease(ctx: QueryCtx) {
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
}

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
export const getUnfinishedUpdate = platformAdminQuery({
	args: {},
	handler: async (ctx) => await readUnfinishedUpdate(ctx),
});

/** The body of `getUnfinishedUpdate`. */
export async function readUnfinishedUpdate(ctx: QueryCtx) {
	const [newest] = await ctx.db
		.query('systemUpdates')
		.withIndex('by_kind_and_startedAt', (q) => q.eq('kind', 'updateRun'))
		.order('desc')
		.take(1);
	if (!newest || newest.status !== 'running') return null;
	return { runId: newest._id, versionTo: newest.versionTo ?? null };
}

/**
 * Mark the open update run as still rolling out.
 *
 * The admin tab following a rollout calls this every
 * `ROLLOUT_HEARTBEAT_MS` until it has the updater's verdict. It is the only
 * live evidence there is: the row's `running` status is not, because the
 * happy path orphans it (see `getUnfinishedUpdate`) and a closed tab leaves it
 * open for good. A run that already has a verdict, or was superseded, is left
 * alone, so a heartbeat queued while the socket was down cannot reopen it.
 *
 * Platform-admin only, and public because the admin's browser calls it.
 */
export const recordUpdateActivity = platformAdminMutation({
	args: {},
	handler: async (ctx) => await markUpdateActivity(ctx),
});

/** The body of `recordUpdateActivity`. */
export async function markUpdateActivity(ctx: MutationCtx) {
	const [newest] = await ctx.db
		.query('systemUpdates')
		.withIndex('by_kind_and_startedAt', (q) => q.eq('kind', 'updateRun'))
		.order('desc')
		.take(1);
	if (!newest || newest.status !== 'running') return;
	await ctx.db.patch(newest._id, { lastActivityAt: Date.now() });
}

/**
 * The open update run's last confirmed activity: `{ activeAt: null }` when no
 * run is open, and `null` when the caller may not see it (anonymous, or not an
 * active member).
 *
 * The app shell reads this while connected so that, when the rollout restarts
 * the backend and the socket drops, it can say "update in progress" instead of
 * "connection lost". `activeAt` is the last heartbeat (`recordUpdateActivity`),
 * or the start for a run that has none yet. The shell trusts it only while it
 * sees it advance: an orphaned `running` row answers here too, but its value
 * never changes again. Only that timestamp leaves here: versions, the
 * initiating admin and step logs stay platform-admin only. The two empty
 * answers differ because the activity is instance-wide: the shell must take the
 * first answer after gaining visibility (signing in, joining an organization)
 * as a baseline, not as a run that just opened.
 */
// authz: readRolloutActivity answers null unless isActiveOrgMember admits the caller.
// public: the app shell subscribes before it knows the caller is a member; an anonymous or non-member caller gets null instead of an error.
export const getRolloutActivity = publicQuery({
	args: {},
	handler: async (ctx) => await readRolloutActivity(ctx),
});

/** The body of `getRolloutActivity`. */
export async function readRolloutActivity(ctx: QueryCtx) {
	if (!(await isActiveOrgMember(ctx))) return null;
	const [newest] = await ctx.db
		.query('systemUpdates')
		.withIndex('by_kind_and_startedAt', (q) => q.eq('kind', 'updateRun'))
		.order('desc')
		.take(1);
	if (!newest || newest.status !== 'running') return { activeAt: null };
	return { activeAt: newest.lastActivityAt ?? newest.startedAt ?? null };
}

/** `listUpdateHistory`'s arguments. */
export const updateHistoryArgs = { limit: v.optional(v.number()) };

export const listUpdateHistory = platformAdminQuery({
	args: updateHistoryArgs,
	handler: async (ctx, args) => await listUpdateRuns(ctx, args),
});

/** The body of `listUpdateHistory`. */
export async function listUpdateRuns(ctx: QueryCtx, args: ObjectType<typeof updateHistoryArgs>) {
	const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
	return await ctx.db
		.query('systemUpdates')
		.withIndex('by_kind_and_startedAt', (q) => q.eq('kind', 'updateRun'))
		.order('desc')
		.take(limit);
}
