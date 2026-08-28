import { type Infer, v } from 'convex/values';
import { matchesValidator } from '../lib/validatorMatch';
import { envelopeInputValidator, retryStateValidator } from './workerEnvelope';

// ============================================================================
// The worker → completion wire (module).
//
// ONE TYPE, FIVE ARMS, ONE DISCRIMINANT. `delivery/worker.ts` produces this,
// `delivery/governedDispatch.ts` builds four of its arms, and
// `delivery/sendCompletion.ts` consumes it out of the workpool's
// `result.returnValue`. It is the same object all three name, so an arm cannot
// be added on one side and missed on the other.
//
// WHY A `kind`. The shipped shape was keyed on `success` plus a handful of
// overlapping optional booleans: two arms differed only by the PRESENCE of
// `awaitingProviderFeedback`, `{ success: false, suppressed: true }` existed at
// runtime without existing in the type at all, and every illegal combination —
// `deferred` AND `acceptanceUnknown`, `success: true` with no message id —
// type-checked. The consumer then re-derived the arms with a hand-ordered
// if-chain, and anything that matched none of its conditions fell through to a
// terminal `WORKPOOL_FAILED`: a definite non-delivery claimed for a message
// whose fate was simply unreadable. A discriminant makes the arms exhaustive
// for the compiler and unreadable values loud rather than silent.
//
// WHY A VALIDATOR AND NOT AN INTERFACE. The workpool component types
// `result.returnValue` as `any`, so nothing about it is checked on the way
// back in. Declaring the union as a Convex validator lets it be BOTH the
// worker action's `returns` gate and the shape the completion callback matches
// an untrusted value against (`isSendWorkerOutcome`), with the TypeScript type
// inferred from the same object so the three cannot drift.
// ============================================================================

/**
 * The transport accepted the message.
 *
 * `isCustodyHandoff` distinguishes the two things acceptance can mean, and it
 * is a REQUIRED boolean rather than an optional marker so a producer must say
 * which one it saw:
 *
 *   · `true`  — the transport took CUSTODY (its catalog entry declares
 *     `acceptanceSemantics: 'accepted'`): intake accepted the work and delivery
 *     remains queued until the transport's own feedback terminalizes the Send.
 *   · `false` — the send itself succeeded; the Send transitions to `sent`.
 */
const acceptedArm = v.object({
	kind: v.literal('accepted'),
	providerMessageId: v.string(),
	providerType: v.string(),
	sendLatencyMs: v.number(),
	isCustodyHandoff: v.boolean(),
});

/**
 * A last-mile deferral: the message was NOT dispatched (or was withdrawn at
 * intake) and waits to be re-entered.
 *
 * `deferralOrigin` is required. Only `governed` is evidence about this sending
 * identity and only `governed` reaches gate 2's numerator; `local` — a policy
 * hold, an idempotency wait, an unreachable decision endpoint, an MTA answer
 * reporting any Redis failure while taking the lease — is our own machinery
 * wherever it runs. Reaching the MTA is not what makes a deferral governed; the
 * answer being ABOUT the sending identity is. The routing layer always names an
 * origin (`LastMileRoutingDeferred.origin`), so an unlabelled deferral is not
 * an older worker to be tolerated — it is a value this consumer cannot read.
 */
const deferredArm = v.object({
	kind: v.literal('deferred'),
	retryAfterMs: v.number(),
	deferralOrigin: v.union(v.literal('governed'), v.literal('local')),
	envelopeInput: envelopeInputValidator,
	retryState: retryStateValidator,
});

/**
 * ACCEPTANCE IS OPEN AND CAN BE RE-ASKED (plan D4).
 *
 * A transport that takes custody under an idempotency key we minted answers the
 * same question twice without mailing anyone twice: its idempotency key IS the
 * transport's message id, so a repeat dispatch either finds the existing work or
 * creates it. The ambiguity is resolved by REPLAYING the attempt, which is why
 * this arm — alone among the two ambiguous ones — carries an envelope.
 */
const acceptanceUnknownArm = v.object({
	kind: v.literal('acceptanceUnknown'),
	providerMessageId: v.string(),
	workAttemptId: v.string(),
	startedAt: v.number(),
	envelopeInput: envelopeInputValidator,
	retryState: retryStateValidator,
	retryAfterMs: v.optional(v.number()),
});

/**
 * ACCEPTANCE IS OPEN AND CANNOT BE RE-ASKED (plan D4).
 *
 * A relay that has no idempotency surface — Mandrill's `send-raw` has none —
 * offers no second question. The lost response may sit on top of an ACCEPTED
 * and DELIVERED message, so this arm carries no envelope and no message id:
 * there is deliberately nothing here a caller could re-dispatch from.
 *
 * What it asks the completion callback for is a PARK, not a retry: keep the
 * Send `queued` — the state that says "we do not know yet", which is the truth
 * — until the delivery deadline, then terminalize with a code that says so.
 * `queued` is also the only state a later transition can still leave; `failed`
 * is terminal in `LEGAL_EDGES`, so terminalizing here would close the row
 * against every piece of evidence that could still arrive AND claim a definite
 * non-delivery for a message that may well have been delivered.
 */
const awaitingFeedbackArm = v.object({
	kind: v.literal('awaitingFeedback'),
	providerType: v.string(),
	startedAt: v.number(),
	retryState: retryStateValidator,
});

/**
 * The recipient was on the blocklist at the worker's pre-dispatch suppression
 * re-check, so nothing was dispatched at all — the send was deliberately NOT
 * delivered.
 *
 * The worker RETURNS this rather than throwing, so the workpool run counts as a
 * success and is not retried; the completion callback turns it into a terminal,
 * suppression-labelled non-delivery. It never reached the governed dispatch
 * boundary, which is why it is the one arm `governedDispatch.ts` never builds —
 * and why, while it was missing from the type, it was a runtime shape nothing
 * described.
 */
const suppressedArm = v.object({ kind: v.literal('suppressed') });

export const sendWorkerOutcomeValidator = v.union(
	acceptedArm,
	deferredArm,
	acceptanceUnknownArm,
	awaitingFeedbackArm,
	suppressedArm
);

/**
 * The single wire type of the worker → completion seam.
 *
 * Inferred from the validator rather than declared beside it: the validator is
 * what the worker action is gated on and what the completion callback matches
 * against, so a hand-written twin could only ever be a second place to forget.
 */
export type SendWorkerOutcome = Infer<typeof sendWorkerOutcomeValidator>;

/** The discriminant, so consumers can name an arm without restating a literal. */
export type SendWorkerOutcomeKind = SendWorkerOutcome['kind'];

/**
 * Does an untrusted workpool `returnValue` carry one of the five arms?
 *
 * The workpool component hands `result.returnValue` back as `any`. This is the
 * gate that replaces the cast: the value is matched against the very validator
 * the worker action declares as its `returns`, so a value that fails here is
 * one no build of the worker could have produced — a stale in-flight job from a
 * previous shape, a hand-fired callback, or a defect — and the consumer answers
 * loudly rather than terminalizing it as an ordinary send failure.
 */
export function isSendWorkerOutcome(value: unknown): value is SendWorkerOutcome {
	return matchesValidator(sendWorkerOutcomeValidator, value);
}
