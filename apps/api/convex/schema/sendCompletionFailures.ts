import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { bounceTypeValidator } from '../lib/literalValidators';
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

/**
 * Provider feedback that arrived while the completion was still unrecorded.
 *
 * The Send is `queued` until its completion replays, and the lifecycle refuses
 * a terminal provider event against `queued` (`queued -> bounced` is not an
 * edge). Rather than drop the event, the webhook path parks it here and the
 * replay applies it right after the completion, in the same transaction. Only
 * the terminal and delivery transitions are parked: opens and clicks are
 * engagement counters a provider does not hold back for us.
 */
export const parkedFeedbackTransitionValidator = v.union(
	v.object({
		to: v.literal('bounced'),
		at: v.number(),
		bounceType: bounceTypeValidator,
		bounceMessage: v.optional(v.string()),
	}),
	v.object({ to: v.literal('complained'), at: v.number() }),
	v.object({ to: v.literal('delivered'), at: v.number() }),
	v.object({
		to: v.literal('failed'),
		at: v.number(),
		errorMessage: v.string(),
		errorCode: v.string(),
	})
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
 * `delivery/sendCompletionFailures.ts`.
 *
 * The row itself is small metadata. The worker outcome a replay runs lives in
 * `sendCompletionFailurePayloads`, one row per record, in a compact form capped
 * at 32 KiB that never holds the envelope (recipient and rendered message):
 * see `delivery/sendCompletionPayload.ts`. Only the replay of one record loads
 * its payload. The payload is deleted as soon as the record
 * resolves; the summary columns stay for the audit trail. Contact erasure
 * deletes a contact's records and their payloads in a phase of its own, and no
 * record is written for a Send that is already soft-deleted. Resolved records
 * are purged 30 days after their last failure, exhausted ones after 90.
 */
export const sendCompletionFailureTables = {
	sendCompletionFailures: defineTable({
		sendRef: countableSendRefValidator,
		// The Send's contact, copied when the row is written, so contact erasure
		// finds every row by index (`contacts/erasure/phases.ts`).
		contactId: v.optional(v.id('contacts')),
		// The workpool work id the completion belonged to: a second `onComplete`
		// for the same work updates this row instead of adding another.
		workId: v.string(),
		// Summary of the outcome in the payload row. `outcomeKind` is the worker
		// outcome's `kind`, or the run result's `failed` / `canceled`, or
		// `unreadable` for a value no worker build produces.
		outcomeKind: v.string(),
		providerMessageId: v.optional(v.string()),
		providerType: v.optional(v.string()),
		status: sendCompletionFailureStatusValidator,
		// `retried`: the completion threw while re-entering a deferral or an open
		// acceptance, and the record re-entered the Send itself at once.
		resolution: v.optional(
			v.union(v.literal('replayed'), v.literal('superseded'), v.literal('retried'))
		),
		// A fixed diagnostic code for the latest error (`CONVEX_VALIDATION`,
		// `MTA_IDENTITY_CONFLICT`, `UNKNOWN`, …), never its message text: a
		// validation error quotes the document it refused.
		lastError: v.string(),
		// Provider events that arrived before the completion could be replayed,
		// at most one per kind (`delivery/sendCompletionFeedback.ts`).
		pendingFeedback: v.optional(
			v.array(v.object({ transition: parkedFeedbackTransitionValidator, receivedAt: v.number() }))
		),
		// Parked events the lifecycle refused when the replay applied them.
		feedbackRefusals: v.optional(
			v.array(v.object({ to: v.string(), at: v.number(), reason: v.string() }))
		),
		// Cron replays only; a webhook or operator replay does not spend the cap.
		replayAttempts: v.number(),
		firstFailedAt: v.number(),
		lastFailedAt: v.number(),
		nextReplayAt: v.optional(v.number()),
		resolvedAt: v.optional(v.number()),
	})
		.index('by_status_and_next_replay', ['status', 'nextReplayAt'])
		.index('by_status_and_last_failed_at', ['status', 'lastFailedAt'])
		.index('by_work_id', ['workId'])
		.index('by_send_and_status', ['sendRef.id', 'status'])
		.index('by_contact', ['contactId']),

	// The worker outcome of one record in its compact form
	// (`delivery/sendCompletionPayload.ts`): envelopes emptied, at most 32 KiB.
	// Read only by that record's replay; deleted when it resolves or is purged.
	sendCompletionFailurePayloads: defineTable({
		failureId: v.id('sendCompletionFailures'),
		result: workpoolRunResultValidator,
		isEnvelopeStripped: v.optional(v.boolean()),
	}).index('by_failure', ['failureId']),
};
