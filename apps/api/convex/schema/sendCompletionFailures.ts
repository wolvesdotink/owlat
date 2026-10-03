import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { countableSendRefValidator } from '../lib/validators/send';

/**
 * The workpool's run result as `@convex-dev/workpool` hands it to `onComplete`
 * (its `vResult`), restated here so the schema does not load the component's
 * client module. `returnValue` stays open on purpose: the completion reads it
 * through `isSendWorkerOutcome`, never through a cast, so an old or malformed
 * value is replayed down the same named path it would have taken live.
 */
export const workpoolRunResultValidator = v.union(
	v.object({ kind: v.literal('success'), returnValue: v.any() }),
	v.object({ kind: v.literal('failed'), error: v.string() }),
	v.object({ kind: v.literal('canceled') })
);

export const sendCompletionFailureStatusValidator = v.union(
	// Waiting for the replay cron (`nextReplayAt`).
	v.literal('open'),
	// The cron gave up after its attempt cap; an operator replays or re-opens it.
	v.literal('exhausted'),
	// Settled: replayed, or the Send was moved by something else first.
	v.literal('resolved')
);

/**
 * Durable record of a send completion that threw (#1195).
 *
 * The workpool keeps no trace of an `onComplete` mutation that fails: it logs
 * and deletes the work row, and the worker's result (the only place a direct
 * provider's message id exists) is gone. `delivery/sendCompletion.ts` catches
 * that failure and writes one row here instead, in the same transaction that
 * stamps the provider identity onto the still-queued Send. Rows are replayed by
 * `delivery/sendCompletionFailures.ts` and purged 30 days after they resolve.
 *
 * `result` carries the worker outcome verbatim, so a replay runs exactly the
 * completion that failed. A deferral's outcome includes its envelope (the
 * recipient and the rendered message), so the payload is dropped as soon as the
 * row resolves; the summary columns stay for the audit trail.
 */
export const sendCompletionFailureTables = {
	sendCompletionFailures: defineTable({
		sendRef: countableSendRefValidator,
		// The workpool work id the completion belonged to: a second `onComplete`
		// for the same work updates this row instead of adding another.
		workId: v.string(),
		result: v.optional(workpoolRunResultValidator),
		// Summary, kept after `result` is dropped. `outcomeKind` is the worker
		// outcome's `kind`, or the run result's `failed` / `canceled`, or
		// `unreadable` for a value no worker build produces.
		outcomeKind: v.string(),
		providerMessageId: v.optional(v.string()),
		providerType: v.optional(v.string()),
		status: sendCompletionFailureStatusValidator,
		resolution: v.optional(v.union(v.literal('replayed'), v.literal('superseded'))),
		// The latest error, clamped.
		lastError: v.string(),
		// Cron replays only; a webhook or operator replay does not spend the cap.
		replayAttempts: v.number(),
		firstFailedAt: v.number(),
		lastFailedAt: v.number(),
		nextReplayAt: v.optional(v.number()),
		resolvedAt: v.optional(v.number()),
	})
		.index('by_status_and_next_replay', ['status', 'nextReplayAt'])
		.index('by_status_and_resolved_at', ['status', 'resolvedAt'])
		.index('by_work_id', ['workId'])
		.index('by_send', ['sendRef.id']),
};
