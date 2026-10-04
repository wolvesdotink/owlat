import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { logInfo } from '../lib/runtimeLog';
import { unresolvedCompletionFailures } from './sendCompletionFeedback';
import {
	deadlineSweepCutoff,
	LOST_SEND_PAGE_MAX_BYTES,
	lostSendCandidates,
	startLostSendPasses,
	sweepableAt,
	UNANCHORED_MIN_AGE_MS,
	type SweepTable,
} from './stuckSendSweep';

// ============================================================================
// Lost-send sweep — the operator surface (#1208). The sweep itself and the
// rules for what is lost live in `./stuckSendSweep`; this module shows the
// queue and fails the Sends the cron cannot judge (apps/docs "Platform
// operations").
//
// READ BUDGET. A Send row can be a whole Convex document (1 MiB), so
// `status` reads one range of one table per call, one page of at most 100 rows
// and `LOST_SEND_PAGE_MAX_BYTES` (2 MiB, overshooting by at most the one row
// that crosses it), then looks up the completion-failure records of the first
// 10 rows (at most 2 x 10 x 8 KiB each). Worst case: 3 MiB + 1.6 MiB = 4.6 MiB
// against the 16 MiB transaction limit. A longer range is counted by calling
// again with `continueCursor` and the first page's `asOf`.
// `failUnanchoredLostSends` reads only its two lease rows and schedules the
// sweep's own pages (see `./stuckSendSweep`).
// ============================================================================

const STATUS_PAGE_SIZE = 100;
const STATUS_SAMPLE_SIZE = 10;

type SendRow = Doc<'emailSends'> | Doc<'transactionalSends'>;

const statusTables = { campaign: 'emailSends', transactional: 'transactionalSends' } as const;

/**
 * Operator: what the lost-send sweep sees in one range of one send table.
 * `npx convex run delivery/stuckSendSweepAdmin:status '{"kind": "campaign", "range": "due"}'`
 * (`kind`: `campaign` or `transactional`; `range`: `due` or `unanchored`).
 *
 * - `due`: Sends the next cron tick fails (first attempt past the deadline plus
 *   the grace), oldest first attempt first. A sampled row with
 *   `hasOpenCompletionFailure` is left to `sendCompletionFailureAdmin` instead.
 * - `unanchored`: queued Sends with no provider id and no recorded first
 *   attempt, oldest first. Most are simply waiting for their first attempt
 *   (a scheduled or send-time-optimized campaign); the cron never touches them.
 *   `pastMinimumAge` counts those older than `UNANCHORED_MIN_AGE_MS`, which
 *   `failUnanchoredLostSends` may fail.
 *
 * `counted` covers this page only. When `isDone` is false, pass
 * `continueCursor` as `cursor` AND the first page's `asOf` back to count the
 * next page; the page stops early when its rows are large. Every page of one
 * count is judged as of that one instant: a Convex cursor only resumes the
 * query it came from, and the range's cutoff is part of that query, so a
 * continuation that recomputed it from the clock would be refused.
 */
export const status = internalQuery({
	args: {
		kind: v.union(v.literal('campaign'), v.literal('transactional')),
		range: v.union(v.literal('due'), v.literal('unanchored')),
		cursor: v.optional(v.string()),
		// The instant the first page was read, returned by it. Required with
		// `cursor`.
		asOf: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		if (args.cursor !== undefined && args.asOf === undefined) {
			throw new Error('A continuation needs the asOf its first page returned.');
		}
		const now = args.asOf ?? Date.now();
		const table: SweepTable = statusTables[args.kind];
		const mode = args.range === 'due' ? 'deadline' : 'unanchored';
		const cutoff = mode === 'deadline' ? deadlineSweepCutoff(now) : now;
		const page = await lostSendCandidates(ctx, table, mode, cutoff).paginate({
			numItems: STATUS_PAGE_SIZE,
			cursor: args.cursor ?? null,
			maximumBytesRead: LOST_SEND_PAGE_MAX_BYTES,
		});
		const rows: SendRow[] = page.page;
		const unanchoredFloor = now - UNANCHORED_MIN_AGE_MS;
		return {
			kind: args.kind,
			range: args.range,
			asOf: now,
			counted: rows.length,
			isDone: page.isDone,
			continueCursor: page.isDone ? null : page.continueCursor,
			pastMinimumAge:
				args.range === 'unanchored'
					? rows.filter((row) => row._creationTime <= unanchoredFloor).length
					: null,
			unanchoredMinimumAgeMs: UNANCHORED_MIN_AGE_MS,
			sample: await Promise.all(
				rows.slice(0, STATUS_SAMPLE_SIZE).map(async (row) => ({
					sendId: row._id,
					createdAt: row._creationTime,
					firstAttemptAt: row.firstAttemptAt ?? null,
					sweepableAt: row.firstAttemptAt === undefined ? null : sweepableAt(row.firstAttemptAt),
					hasOpenCompletionFailure: (await unresolvedCompletionFailures(ctx, row._id)).length > 0,
				}))
			),
		};
	},
});

/**
 * Operator: fail the queued Sends with no provider id and no recorded first
 * attempt that were created before `createdBefore`, in both send tables. These
 * are the rows the cron cannot judge: the #1184 Sends, written before
 * `firstAttemptAt` existed, and work the workpool lost before its first
 * attempt. `createdBefore` must be at least `UNANCHORED_MIN_AGE_MS` (eight days)
 * in the past, the longest a live Send can wait for its first attempt plus its
 * whole delivery window. A Send with an open completion-failure record is left
 * to that record. Each Send ends `failed` with `SEND_COMPLETION_LOST`.
 *
 * Runs in the background, one page per transaction; `status` shows what is
 * left.
 */
export const failUnanchoredLostSends = internalMutation({
	args: { createdBefore: v.number() },
	handler: async (ctx, { createdBefore }) => {
		const latest = Date.now() - UNANCHORED_MIN_AGE_MS;
		if (!Number.isFinite(createdBefore) || createdBefore > latest) {
			throw new Error(
				`createdBefore must be at least ${UNANCHORED_MIN_AGE_MS / 86_400_000} days in the past (at most ${latest}).`
			);
		}
		// The operator's word wins: a running unanchored pass is taken over and
		// stops at its next page.
		await startLostSendPasses(ctx, 'unanchored', createdBefore, { isTakeover: true });
		logInfo('[LostSendSweep] Operator started the unanchored pass', { createdBefore });
		return { isStarted: true, createdBefore };
	},
});
