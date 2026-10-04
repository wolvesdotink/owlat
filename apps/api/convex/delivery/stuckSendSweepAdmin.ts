import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { logInfo } from '../lib/runtimeLog';
import { unresolvedCompletionFailures } from './sendCompletionFeedback';
import {
	deadlineSweepCutoff,
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
// READ BUDGET. `status` reads at most 2 tables x 2 ranges x 101 queued Sends
// and one `sendCompletionFailures` lookup (two ranges of 10) per sampled row.
// A queued Send row is small (a transactional one carries its data variables),
// well under the 16 MiB transaction limit at that count.
// ============================================================================

const STATUS_COUNT_LIMIT = 100;
const STATUS_SAMPLE_SIZE = 10;

type SendRow = Doc<'emailSends'> | Doc<'transactionalSends'>;

/**
 * Operator: what the lost-send sweep sees, per send table.
 * `npx convex run delivery/stuckSendSweepAdmin:status`. Counts stop at 100
 * (`isCountCapped`).
 *
 * - `due`: Sends the next cron tick fails (first attempt past the deadline plus
 *   the grace). A sampled row with `hasOpenCompletionFailure` is left to
 *   `sendCompletionFailureAdmin` instead.
 * - `unanchored`: queued Sends with no provider id and no recorded first
 *   attempt, oldest first. Most are simply waiting for their first attempt
 *   (a scheduled or send-time-optimized campaign); the cron never touches them.
 *   `pastMinimumAge` counts those older than `UNANCHORED_MIN_AGE_MS`, which
 *   `failUnanchoredLostSends` may fail.
 */
export const status = internalQuery({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const deadlineCutoff = deadlineSweepCutoff(now);
		const unanchoredFloor = now - UNANCHORED_MIN_AGE_MS;
		const sample = async (rows: SendRow[]) =>
			await Promise.all(
				rows.slice(0, STATUS_SAMPLE_SIZE).map(async (row) => ({
					sendId: row._id,
					createdAt: row._creationTime,
					firstAttemptAt: row.firstAttemptAt ?? null,
					sweepableAt: row.firstAttemptAt === undefined ? null : sweepableAt(row.firstAttemptAt),
					hasOpenCompletionFailure: (await unresolvedCompletionFailures(ctx, row._id)).length > 0,
				}))
			);
		const table = async (name: SweepTable) => {
			const due = await lostSendCandidates(ctx, name, 'deadline', deadlineCutoff).take(
				STATUS_COUNT_LIMIT + 1
			);
			const unanchored = await lostSendCandidates(ctx, name, 'unanchored', now).take(
				STATUS_COUNT_LIMIT + 1
			);
			return {
				due: Math.min(due.length, STATUS_COUNT_LIMIT),
				unanchored: Math.min(unanchored.length, STATUS_COUNT_LIMIT),
				pastMinimumAge: unanchored
					.slice(0, STATUS_COUNT_LIMIT)
					.filter((row) => row._creationTime <= unanchoredFloor).length,
				isCountCapped: due.length > STATUS_COUNT_LIMIT || unanchored.length > STATUS_COUNT_LIMIT,
				oldestUnanchoredCreatedAt: unanchored[0]?._creationTime ?? null,
				dueSample: await sample(due),
				unanchoredSample: await sample(unanchored),
			};
		};
		return {
			unanchoredMinimumAgeMs: UNANCHORED_MIN_AGE_MS,
			campaign: await table('emailSends'),
			transactional: await table('transactionalSends'),
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
		await startLostSendPasses(ctx, 'unanchored', createdBefore);
		logInfo('[LostSendSweep] Operator started the unanchored pass', { createdBefore });
		return { isStarted: true, createdBefore };
	},
});
