import { type Infer, v } from 'convex/values';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS, governedDeliveryDeadlineAt } from '@owlat/shared';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { logInfo } from '../lib/runtimeLog';
import { countableSendRefValidator } from '../lib/validators/send';
import { MAX_SEND_TIME_WINDOW_HOURS } from '../campaigns/sendTimeOptimization';
import { unresolvedCompletionFailures } from './sendCompletionFeedback';

// ============================================================================
// Lost-send sweep (#1208).
//
// A Send stays `queued` with no provider message id when no completion ever
// reached it: work the workpool lost, or a completion that threw before
// `sendCompletionFailures` existed (#1184). Provider feedback cannot find it
// (it has no id), so its campaign stays `sending`. This module fails such a
// Send with `SEND_COMPLETION_LOST` once nothing can still settle it.
//
// WHEN NOTHING CAN STILL SETTLE IT. Every attempt passes
// `routingReentry.issueSnapshot`, which records the attempt chain's start on
// the Send (`firstAttemptAt`) and refuses an attempt past the four-day
// deadline measured from it, as does dispatch itself. So once
// `governedDeliveryDeadlineAt(firstAttemptAt)` has passed, no new attempt can
// dispatch: a pending deferral retry, a re-entry or a backlogged workpool job
// can only end in `failed`. What can still land is an attempt that was admitted
// just before the deadline and is mid-flight (an action runs at most 10
// minutes) and its completion. `LOST_SEND_GRACE_MS` (one day) covers that with a
// wide margin. Send-time optimization and every other delay BEFORE the first
// attempt do not matter here: the clock starts at the attempt, not at queueing.
//
// WHAT IS NEVER SWEPT
//   - a Send with a provider message id: a custody handoff (MTA), a stamped
//     acceptance, or a direct provider's id. Provider feedback can reach it.
//   - a Send with an open or exhausted `sendCompletionFailures` record: its
//     outcome is known and the replay or an operator closes it.
//   - a Send without `firstAttemptAt`: never attempted since this field
//     shipped, or written before it. Its deadline is unknown, so the cron leaves
//     it alone. `stuckSendSweepAdmin:status` lists those rows and
//     `stuckSendSweepAdmin:failUnanchoredLostSends` fails them on an operator's
//     word, only once they are older than `UNANCHORED_MIN_AGE_MS`.
//
// BOUNDED BY BYTES, NOT ONLY ROWS. A Send row can be as large as a Convex
// document (1 MiB: a transactional Send carries its data variables), and a
// transaction may read 16 MiB. Both passes read one index range
// (`by_status_provider_first_attempt`: queued, no provider id, by first
// attempt) a page at a time, at most `SWEEP_PAGE_SIZE` rows and
// `LOST_SEND_PAGE_MAX_BYTES` (2 MiB) per page, continued by cursor so rows it
// skips are passed over rather than read again. The page only reads; each
// candidate is judged and failed in a transaction of its own (`failLostSend`,
// scheduled), so a Send whose lifecycle throws (the #1184 fault) rolls back
// alone and the next pass tries it again.
//
// ONE PASS AT A TIME. Each pass kind (table x mode) holds a lease row
// (`lostSendSweepLeases`) while its chain runs. The hourly cron skips a table
// whose previous pass is still scheduling, so passes never overlap and each
// candidate gets at most one `failLostSend` per pass; a page also skips Sends
// with an unresolved completion-failure record, which can sit in the range
// for as long as the record waits for an operator.
//
// WORST CASE PER TRANSACTION, every document at the 1 MiB maximum:
//   - cron tick / operator pass: two lease rows (a few hundred bytes each).
//   - a page: its lease row, 2 MiB of candidates plus the one row that crosses
//     the budget (1 MiB), and two first-row record lookups per candidate (at
//     most 25 x 2 x 8 KiB = 400 KiB): about 3.4 MiB.
//   - `failLostSend` for a transactional Send: the Send read three times (this
//     judgment, then the lifecycle's load and its patch), plus its records (at
//     most 2 x 10 x 8 KiB = 160 KiB) and small source rows: about 3.2 MiB.
//   - `failLostSend` for a campaign Send: the same three reads, then campaign
//     reconciliation (`campaigns/lifecycle.ts:tryCompleteCampaign`) reads the
//     campaign, its send job, one other Send of the campaign and either a
//     second one still queued or, when the campaign completes, the campaign
//     again for its patch. Seven documents plus records, a stat shard, a
//     listing counter and an audit row: about 7.3 MiB. The live completion runs
//     the same transition on the same rows, so a sweep costs no more than any
//     completion of that Send.
// Measured with ~0.95 MiB documents (`__tests__/stuckSendSweepLimits`): a page
// and a `status` page fit under 3 MiB; `failLostSend` under 3 MiB for a
// transactional Send and under 6.75 MiB (failing at 6.5 MiB) for a campaign
// Send whose campaign, send job and sibling Sends are all that large.
// ============================================================================

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long past its delivery deadline a Send must stay unsettled. */
export const LOST_SEND_GRACE_MS = DAY_MS;

/**
 * The youngest a Send without `firstAttemptAt` may be when an operator fails
 * it: the longest send-time optimization delay before the first attempt, the
 * delivery window after it, and the grace. Eight days.
 */
export const UNANCHORED_MIN_AGE_MS =
	MAX_SEND_TIME_WINDOW_HOURS * HOUR_MS + GOVERNED_MTA_MAX_MESSAGE_AGE_MS + LOST_SEND_GRACE_MS;

export const LOST_SEND_ERROR_CODE = 'SEND_COMPLETION_LOST';
const LOST_SEND_MESSAGE =
	'No completion reached this send before its delivery deadline; the message may or may not have been delivered';
const UNANCHORED_LOST_SEND_MESSAGE =
	'Closed by an operator: no completion reached this send and it predates first-attempt tracking; the message may or may not have been delivered';

/** Rows per sweep page; each candidate is then failed in its own transaction. */
export const SWEEP_PAGE_SIZE = 25;

/**
 * Bytes a sweep or `status` page may read before it stops early. The read can
 * overshoot by the one row that crosses it, at most a document (1 MiB).
 */
export const LOST_SEND_PAGE_MAX_BYTES = 2 * 1024 * 1024;

export const sweepTableValidator = v.union(
	v.literal('emailSends'),
	v.literal('transactionalSends')
);
export type SweepTable = Infer<typeof sweepTableValidator>;

/**
 * `deadline`: the cron's pass, Sends whose recorded first attempt is past the
 * deadline plus the grace. `unanchored`: the operator's pass, Sends with no
 * recorded first attempt created before a cutoff.
 */
export const sweepModeValidator = v.union(v.literal('deadline'), v.literal('unanchored'));
export type SweepMode = Infer<typeof sweepModeValidator>;

/**
 * The newest first attempt the cron may sweep at `now`. A Send whose
 * `firstAttemptAt` is below this is past `governedDeliveryDeadlineAt` by more
 * than the grace.
 */
export function deadlineSweepCutoff(now: number): number {
	return now - GOVERNED_MTA_MAX_MESSAGE_AGE_MS - LOST_SEND_GRACE_MS;
}

/** When the cron may sweep a Send first attempted at `firstAttemptAt`. */
export function sweepableAt(firstAttemptAt: number): number {
	return governedDeliveryDeadlineAt(firstAttemptAt) + LOST_SEND_GRACE_MS;
}

type SendRow = Doc<'emailSends'> | Doc<'transactionalSends'>;

/**
 * The sweep candidates of one table, oldest first: `queued`, no provider id,
 * and either first attempted before `cutoff` (`deadline`) or never attempted
 * and created before `cutoff` (`unanchored`). The lower bound on
 * `firstAttemptAt` keeps the unanchored rows (absent sorts first) out of the
 * deadline range.
 */
export function lostSendCandidates(
	ctx: Pick<QueryCtx, 'db'>,
	table: SweepTable,
	mode: SweepMode,
	cutoff: number
) {
	if (table === 'emailSends') {
		return ctx.db.query('emailSends').withIndex('by_status_provider_first_attempt', (q) => {
			const unbound = q.eq('status', 'queued').eq('providerMessageId', undefined);
			return mode === 'deadline'
				? unbound.gte('firstAttemptAt', 0).lt('firstAttemptAt', cutoff)
				: unbound.eq('firstAttemptAt', undefined).lt('_creationTime', cutoff);
		});
	}
	return ctx.db.query('transactionalSends').withIndex('by_status_provider_first_attempt', (q) => {
		const unbound = q.eq('status', 'queued').eq('providerMessageId', undefined);
		return mode === 'deadline'
			? unbound.gte('firstAttemptAt', 0).lt('firstAttemptAt', cutoff)
			: unbound.eq('firstAttemptAt', undefined).lt('_creationTime', cutoff);
	});
}

type LostSendVerdict =
	| { isLost: true }
	| {
			isLost: false;
			reason:
				| 'missing'
				| 'not_queued'
				| 'has_provider_id'
				| 'not_due'
				| 'unanchored'
				| 'anchored'
				| 'too_recent'
				| 'completion_failure_open';
	  };

/**
 * Whether a Send is lost, judged on the row as it is now. The page query
 * narrows by index; this is the authority, so a Send settled, stamped or
 * attempted between the page read and its turn is left alone.
 */
export async function judgeLostSend(
	ctx: Pick<QueryCtx, 'db'>,
	send: SendRow | null,
	mode: SweepMode,
	cutoff: number,
	now: number
): Promise<LostSendVerdict> {
	if (!send) return { isLost: false, reason: 'missing' };
	if (send.status !== 'queued') return { isLost: false, reason: 'not_queued' };
	if (send.providerMessageId !== undefined) return { isLost: false, reason: 'has_provider_id' };
	if (mode === 'deadline') {
		if (send.firstAttemptAt === undefined) return { isLost: false, reason: 'unanchored' };
		if (now < sweepableAt(send.firstAttemptAt)) return { isLost: false, reason: 'not_due' };
	} else {
		// The cron owns a Send that carries its first attempt.
		if (send.firstAttemptAt !== undefined) return { isLost: false, reason: 'anchored' };
		if (send._creationTime >= cutoff || send._creationTime > now - UNANCHORED_MIN_AGE_MS) {
			return { isLost: false, reason: 'too_recent' };
		}
	}
	if ((await unresolvedCompletionFailures(ctx, send._id)).length > 0) {
		return { isLost: false, reason: 'completion_failure_open' };
	}
	return { isLost: true };
}

/**
 * Fail one Send if it is still lost, in its own transaction (scheduled by the
 * page). Returns why it was left alone otherwise. A lifecycle that throws
 * rolls this Send back and fails the scheduled call, which Convex logs; the
 * Send stays `queued` and the next pass tries it again.
 */
export const failLostSend = internalMutation({
	args: {
		sendRef: countableSendRefValidator,
		mode: sweepModeValidator,
		cutoff: v.number(),
	},
	handler: async (ctx, { sendRef, mode, cutoff }) => {
		const now = Date.now();
		const send = await ctx.db.get(sendRef.id);
		const verdict = await judgeLostSend(ctx, send, mode, cutoff, now);
		if (!verdict.isLost) return { isFailed: false, reason: verdict.reason };
		await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
			send: sendRef,
			transition: {
				to: 'failed',
				at: now,
				errorCode: LOST_SEND_ERROR_CODE,
				errorMessage: mode === 'deadline' ? LOST_SEND_MESSAGE : UNANCHORED_LOST_SEND_MESSAGE,
			},
		});
		logInfo('[LostSendSweep] Failed a send no completion reached', {
			sendKind: sendRef.kind,
			sendId: sendRef.id,
			mode,
			firstAttemptAt: send?.firstAttemptAt ?? null,
		});
		return { isFailed: true, reason: null };
	},
});

function refFor(table: SweepTable, send: SendRow) {
	return table === 'emailSends'
		? { kind: 'campaign' as const, id: send._id as Doc<'emailSends'>['_id'] }
		: { kind: 'transactional' as const, id: send._id as Doc<'transactionalSends'>['_id'] };
}

/** Whether a Send has an open or exhausted completion-failure record (2 reads). */
async function hasUnresolvedCompletionFailure(
	ctx: Pick<QueryCtx, 'db'>,
	sendId: SendRow['_id']
): Promise<boolean> {
	for (const status of ['open', 'exhausted'] as const) {
		const row = await ctx.db
			.query('sendCompletionFailures')
			.withIndex('by_send_and_status', (q) => q.eq('sendRef.id', sendId).eq('status', status))
			.first();
		if (row) return true;
	}
	return false;
}

/**
 * A pass whose pages have not stamped its lease for this long has died (a page
 * threw, or a workspace deletion cancelled it) and may be taken over. Pages
 * follow each other with no delay, so a live pass stamps it every few seconds.
 */
export const LOST_SEND_LEASE_STALE_MS = 2 * HOUR_MS;

const passKey = (table: SweepTable, mode: SweepMode) => `${table}:${mode}`;

async function readLease(ctx: Pick<QueryCtx, 'db'>, table: SweepTable, mode: SweepMode) {
	return await ctx.db
		.query('lostSendSweepLeases')
		.withIndex('by_pass', (q) => q.eq('pass', passKey(table, mode)))
		.unique();
}

/**
 * Claim the lease for one pass and return its generation, or `null` when a
 * live pass of the same kind holds it and this is not a takeover.
 */
async function claimLostSendPass(
	ctx: Pick<MutationCtx, 'db'>,
	table: SweepTable,
	mode: SweepMode,
	cutoff: number,
	isTakeover: boolean
): Promise<number | null> {
	const now = Date.now();
	const lease = await readLease(ctx, table, mode);
	if (lease?.isActive && !isTakeover && now - lease.heartbeatAt < LOST_SEND_LEASE_STALE_MS) {
		return null;
	}
	const generation = (lease?.generation ?? 0) + 1;
	const fields = { generation, isActive: true, cutoff, startedAt: now, heartbeatAt: now };
	if (lease) await ctx.db.patch(lease._id, fields);
	else await ctx.db.insert('lostSendSweepLeases', { pass: passKey(table, mode), ...fields });
	return generation;
}

/**
 * One page of one pass over one table, then the next page by cursor until the
 * range is done. The cutoff is fixed for the whole pass so the cursor stays
 * valid. The page only reads the candidates and schedules `failLostSend` for
 * each, which judges the row again as it is then. A Send with an unresolved
 * completion-failure record gets no call: it can stay in the range for as long
 * as that record waits for an operator.
 *
 * The page runs only while its pass holds the lease (`generation`), so a pass
 * that was taken over stops here, and it stamps the lease on the way.
 */
export const sweepLostSendPage = internalMutation({
	args: {
		table: sweepTableValidator,
		mode: sweepModeValidator,
		cutoff: v.number(),
		cursor: v.union(v.string(), v.null()),
		generation: v.number(),
	},
	handler: async (ctx, args) => {
		const lease = await readLease(ctx, args.table, args.mode);
		if (!lease?.isActive || lease.generation !== args.generation) {
			return { scheduled: 0, skipped: 0, isDone: true, isSuperseded: true };
		}
		const page = await lostSendCandidates(ctx, args.table, args.mode, args.cutoff).paginate({
			numItems: SWEEP_PAGE_SIZE,
			cursor: args.cursor,
			maximumBytesRead: LOST_SEND_PAGE_MAX_BYTES,
		});
		let scheduled = 0;
		let skipped = 0;
		for (const send of page.page) {
			if (await hasUnresolvedCompletionFailure(ctx, send._id)) {
				skipped += 1;
				continue;
			}
			await ctx.scheduler.runAfter(0, internal.delivery.stuckSendSweep.failLostSend, {
				sendRef: refFor(args.table, send),
				mode: args.mode,
				cutoff: args.cutoff,
			});
			scheduled += 1;
		}
		if (scheduled > 0) {
			logInfo('[LostSendSweep] Page scheduled', {
				table: args.table,
				mode: args.mode,
				candidates: scheduled,
				skipped,
			});
		}
		// The lease ends with the page chain, not with the `failLostSend` calls it
		// scheduled. When the scheduler is backed up, the next pass (or a
		// takeover) can schedule a second call for a Send whose first one has not
		// run yet: at most one more per pass per Send. That is redundant work,
		// never a second outcome. Each call judges the row again in its own
		// transaction, so the first fails the Send and every later one finds it
		// no longer `queued` and writes nothing
		// (`__tests__/stuckSendSweepPasses.integration.test.ts` pins this).
		await ctx.db.patch(lease._id, { heartbeatAt: Date.now(), isActive: !page.isDone });
		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.delivery.stuckSendSweep.sweepLostSendPage, {
				...args,
				cursor: page.continueCursor,
			});
		}
		return { scheduled, skipped, isDone: page.isDone, isSuperseded: false };
	},
});

/**
 * Start one pass over each send table, each in its own chain (a transaction
 * may run only one paginated query) and each under its lease. The cron skips a
 * table whose previous pass of the same mode is still running; the operator's
 * pass takes the lease over, which stops a running chain at its next page.
 */
export async function startLostSendPasses(
	ctx: Pick<MutationCtx, 'db' | 'scheduler'>,
	mode: SweepMode,
	cutoff: number,
	options: { isTakeover: boolean }
): Promise<{ started: SweepTable[]; busy: SweepTable[] }> {
	const started: SweepTable[] = [];
	const busy: SweepTable[] = [];
	for (const table of ['emailSends', 'transactionalSends'] as const) {
		const generation = await claimLostSendPass(ctx, table, mode, cutoff, options.isTakeover);
		if (generation === null) {
			busy.push(table);
			continue;
		}
		await ctx.scheduler.runAfter(0, internal.delivery.stuckSendSweep.sweepLostSendPage, {
			table,
			mode,
			cutoff,
			cursor: null,
			generation,
		});
		started.push(table);
	}
	return { started, busy };
}

/**
 * Cron: fail the Sends first attempted more than the delivery window plus the
 * grace ago that still have no completion, no provider id and no open
 * completion-failure record. A tick with nothing due is two lease reads, two
 * lease writes and two index range reads.
 */
export const sweepLostSends = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = deadlineSweepCutoff(Date.now());
		const passes = await startLostSendPasses(ctx, 'deadline', cutoff, { isTakeover: false });
		if (passes.busy.length > 0) {
			logInfo('[LostSendSweep] Previous pass still running; not started', { tables: passes.busy });
		}
		return { cutoff, ...passes };
	},
});
