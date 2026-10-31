import { governedDeliveryDeadlineAt } from '@owlat/shared';
import type { Infer } from 'convex/values';
import type { envelopeInputValidator, retryStateValidator } from './workerEnvelope';
import { governedRetryDelayMs } from './sendRetryPlan';
import { isSendWorkerOutcome, type SendWorkerOutcome } from './workerOutcome';
import type { MarketingIneligibility } from '../lib/marketingEligibility';
import { InternalFailure } from '../_utils/errors';

// ============================================================================
// Send completion decisions: what one worker answer does to its Send.
//
// Pure. `sendCompletion.ts:applyCompletion` loads the Send when the arm needs
// it, reads the clock, and runs the step this module returns; every write and
// every schedule happens there, in the order the plan names them.
// ============================================================================

/** The workpool's run result as `onComplete` receives it. */
export type CompletionRunResult =
	| { kind: 'success'; returnValue: unknown }
	| { kind: 'failed'; error: string }
	| { kind: 'canceled' };

/** The Send fields the decisions read. */
export interface CompletionSendState {
	readonly status: string;
	readonly providerMessageId?: string;
}

/** Failures the plan names; the handler throws them, so its writes roll back. */
export type CompletionRefusal =
	/** A replay would re-enter a Send whose envelope was not stored. */
	| 'delivery.envelope_not_stored'
	/** A custody handoff names a different provider message than the Send holds. */
	| 'delivery.send_identity_conflict';

export type CompletionStep =
	/** Nothing to write: the Send is gone or already settled. */
	| { readonly kind: 'none' }
	/** Terminalize the Send through the lifecycle. */
	| { readonly kind: 'fail'; readonly errorMessage: string; readonly errorCode: string }
	/** Terminalize the MTA Send that holds this provider message id. */
	| {
			readonly kind: 'failByProviderMessageId';
			readonly providerMessageId: string;
			readonly errorMessage: string;
			readonly errorCode: string;
	  }
	/** Close a park at its deadline, later or now. */
	| { readonly kind: 'scheduleExpiry'; readonly runAt: number; readonly startedAt: number }
	| { readonly kind: 'expireNow'; readonly startedAt: number }
	/** Re-enter the governed workpool after a delay. */
	| {
			readonly kind: 'scheduleRetry';
			readonly delayMs: number;
			readonly envelopeInput: Infer<typeof envelopeInputValidator>;
			readonly retryState: Infer<typeof retryStateValidator>;
	  }
	/** Record the custodian's identity on the still-queued Send. */
	| {
			readonly kind: 'recordCustody';
			readonly providerMessageId: string;
			readonly providerType: string;
	  }
	/** Transition the Send to `sent`. */
	| { readonly kind: 'markSent'; readonly providerMessageId: string; readonly providerType: string }
	| { readonly kind: 'refuse'; readonly failure: CompletionRefusal };

export interface CompletionPlan {
	/**
	 * Record a governed deferral before the step runs. Set on the deferral that
	 * terminalizes too, so it reaches gate 2's numerator like the re-enqueued ones.
	 */
	readonly recordsDeferral: boolean;
	readonly step: CompletionStep;
}

/**
 * The first stage: whether the run produced a worker outcome at all.
 *
 * `decided` carries the whole plan (a run with no outcome, or one this
 * deployment cannot read); `outcome` goes on to `planCompletionOutcome`, with
 * the Send loaded first when `completionReadsSend` asks for it.
 */
export type CompletionReading =
	| { readonly kind: 'decided'; readonly plan: CompletionPlan; readonly unreadableShape?: string }
	| { readonly kind: 'outcome'; readonly outcome: SendWorkerOutcome };

/**
 * The one non-delivery this module invents rather than reports.
 *
 * A `returnValue` that satisfies none of the five arms is not a send that
 * failed — it is a send whose FATE IS UNREADABLE, and the two must not share an
 * error code. `WORKPOOL_FAILED` says "the send failed", a claim nothing here
 * has evidence for; this code says exactly what happened, so an operator
 * greping for it finds a seam defect rather than a provider outage, and a
 * dashboard counting provider failures does not absorb it silently.
 */
const WORKER_RESULT_MALFORMED_CODE = 'WORKER_RESULT_MALFORMED';
const WORKER_RESULT_MALFORMED_MESSAGE =
	'The send worker answered with a result this deployment cannot read; the message may or may not have been delivered';

/**
 * How each pre-dispatch refusal is recorded. A blocklist hit keeps its original
 * code; a contact that unsubscribed from everything or was deleted gets its own,
 * so the Send's audit trail says why it did not go out.
 */
const SUPPRESSED_SEND_FAILURE = {
	blocklist: {
		message: 'Recipient suppressed (blocklist) before dispatch',
		code: 'RECIPIENT_SUPPRESSED',
	},
	contact_unsubscribed: {
		message: 'Contact unsubscribed from marketing before dispatch',
		code: 'RECIPIENT_UNSUBSCRIBED',
	},
	contact_deleted: { message: 'Contact deleted before dispatch', code: 'CONTACT_DELETED' },
} as const satisfies Record<
	'blocklist' | MarketingIneligibility,
	{ message: string; code: string }
>;

const NONE: CompletionStep = { kind: 'none' };

const plan = (step: CompletionStep, recordsDeferral = false): CompletionPlan => ({
	recordsDeferral,
	step,
});

const fail = (errorMessage: string, errorCode: string): CompletionStep => ({
	kind: 'fail',
	errorMessage,
	errorCode,
});

/**
 * A PII-FREE description of a value this module refused.
 *
 * The rejected value can be an envelope, and an envelope carries the recipient
 * — so the telemetry names the SHAPE (its own field names, and the discriminant
 * if it carries a readable one) and never the contents.
 */
function describeUnreadableResult(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value !== 'object') return typeof value;
	if (Array.isArray(value)) return 'array';
	const record = value as Record<string, unknown>;
	const kind = typeof record['kind'] === 'string' ? String(record['kind']) : '<absent>';
	return `kind=${kind} keys=[${Object.keys(record).sort().join(',')}]`;
}

export function readCompletion(result: CompletionRunResult): CompletionReading {
	// THE RUN PRODUCED NO OUTCOME AT ALL. The action threw, or the pool
	// cancelled the work before it answered. Neither is a worker outcome to be
	// read, and both are precisely what `WORKPOOL_FAILED` has always named.
	if (result.kind !== 'success') {
		const errorMessage = (result.kind === 'failed' ? result.error : '') || 'Unknown error';
		return { kind: 'decided', plan: plan(fail(errorMessage, 'WORKPOOL_FAILED')) };
	}
	// THE GATE THAT REPLACED THE CAST. The workpool hands `returnValue` back
	// as `any`, so this is the first and only place its shape is checked —
	// against the very validator `delivery/worker.ts` declares as its
	// `returns`. A value that fails is one no build of the worker could have
	// produced, and it gets a completion path of its own (loud, and named)
	// rather than being terminalized as an ordinary provider failure.
	if (!isSendWorkerOutcome(result.returnValue)) {
		return {
			kind: 'decided',
			plan: plan(fail(WORKER_RESULT_MALFORMED_MESSAGE, WORKER_RESULT_MALFORMED_CODE)),
			unreadableShape: describeUnreadableResult(result.returnValue),
		};
	}
	return { kind: 'outcome', outcome: result.returnValue };
}

/** Whether `planCompletionOutcome` decides this arm on the Send's current row. */
export function completionReadsSend(outcome: SendWorkerOutcome): boolean {
	return (
		outcome.kind === 'awaitingFeedback' ||
		outcome.kind === 'acceptanceUnknown' ||
		(outcome.kind === 'accepted' && outcome.isCustodyHandoff)
	);
}

/**
 * The second stage: the plan for one worker outcome.
 *
 * `send` is the row as the handler loaded it when `completionReadsSend` is
 * true (`null` once it is gone); the arms that do not read it ignore it.
 */
export function planCompletionOutcome(input: {
	readonly outcome: SendWorkerOutcome;
	readonly send: CompletionSendState | null;
	readonly now: number;
	readonly isEnvelopeStripped: boolean;
}): CompletionPlan {
	const { outcome, send, now, isEnvelopeStripped } = input;
	const isQueued = send?.status === 'queued';
	switch (outcome.kind) {
		// AN AMBIGUITY WITH NO SECOND QUESTION TO ASK. Its own arm,
		// and the opposite of `acceptanceUnknown` below: that one replays the
		// attempt (safe — its idempotency key is the transport's message id),
		// this one must never be replayed, because the lost response may sit on
		// top of an accepted and delivered message.
		//
		// So the Send is PARKED, not retried and not terminalized. It stays
		// `queued` — "we do not know yet", which is the truth and, unlike
		// `failed`, is a state a later transition can still leave. At the
		// cumulative delivery deadline it becomes `failed` with a code that
		// names the actual condition rather than `WORKPOOL_FAILED`, which reads
		// as "the send failed".
		//
		// WHAT IS AND IS NOT REACHABLE IN THAT WINDOW, said plainly. Provider
		// feedback joins on the id the provider returned, and the lost response
		// is precisely why this row never learned one — Mandrill's `send-raw`
		// carries no caller-supplied correlator that its webhook echoes back
		// (`metadata` is a `messages/send` parameter, not a `send-raw` one), so
		// today nothing re-attaches a Mandrill `_id` to a parked row and the
		// park exists to keep the row HONEST and OPEN, not because a specific
		// event is expected. A future reconciler (a `messages/info`/`search`
		// lookup, or a correlator Mandrill agrees to echo) has a `queued` row to
		// bind to; it would have had nothing to bind to had this terminalized on
		// the spot.
		//
		// The campaign it belongs to stays `sending` until this settles, exactly
		// as it does for any other queued send awaiting a terminal webhook — the
		// deadline is the bound (`campaigns/lifecycle.ts:tryCompleteCampaign`).
		case 'awaitingFeedback': {
			if (!isQueued) return plan(NONE);
			// This number becomes a scheduled time: a NaN would throw at `runAt`
			// and a clock-skewed future one would park the row past the deadline
			// it is supposed to be bounded by. The retry state's own start is
			// preferred (it is the FIRST attempt's), the arm's copy is the
			// fallback, and both are normalized to "no later than now", so the
			// worst case is exactly one deadline's wait.
			const reported =
				[outcome.retryState.startedAt, outcome.startedAt].find((candidate) =>
					Number.isFinite(candidate)
				) ?? now;
			const startedAt = Math.min(reported, now);
			const deadlineAt = governedDeliveryDeadlineAt(startedAt);
			return plan(
				now < deadlineAt
					? { kind: 'scheduleExpiry', runAt: deadlineAt, startedAt }
					: { kind: 'expireNow', startedAt }
			);
		}

		// THE RE-ASKABLE AMBIGUITY. The transport takes custody under an
		// idempotency key we minted, so the attempt is replayed rather than
		// guessed at — until the cumulative delivery deadline, past which the
		// intake question is closed under its own name.
		case 'acceptanceUnknown': {
			if (!isQueued) return plan(NONE);
			const retry = retryStep(outcome, now, isEnvelopeStripped);
			if (retry !== null) return plan(retry);
			return plan({
				kind: 'failByProviderMessageId',
				providerMessageId: outcome.providerMessageId,
				errorMessage: 'MTA intake acceptance could not be confirmed before the delivery deadline',
				errorCode: 'MTA_ACCEPTANCE_UNCONFIRMED',
			});
		}

		// THE DEFERRAL IS THE OBSERVATION, not the retry decision that follows
		// it. Recorded before the step, so a deferral that has run out of
		// attempts or outlived the delivery deadline — the one that terminalizes
		// the send — reaches gate 2's numerator exactly like the ones that are
		// re-enqueued. Rate-limited to one event per send per UTC day inside the
		// recorder, and fail-soft: it never rolls back the retry.
		//
		// ONLY THE GOVERNED HALF. A `local` deferral is this deployment holding
		// its own message — a policy pause, an idempotency wait, an MTA decision
		// endpoint we could not reach, an MTA answer reporting any Redis failure
		// while taking the lease — and gate 2 halts a cell at 25%. Reaching the
		// MTA is not what makes a deferral governed; the answer being about the
		// sending identity is. Counting our own outage would take the share to
		// the floor and revoke the graduation pin over a fault the receiver
		// never saw.
		case 'deferred': {
			const recordsDeferral = outcome.deferralOrigin === 'governed';
			// Both bounds, attempts and deadline (`./sendRetryPlan`). Out of routing
			// attempts, or past the cumulative delivery deadline, the wait itself
			// ran out, which is a real non-delivery — the shipped terminalization.
			const retry = retryStep(outcome, now, isEnvelopeStripped);
			return plan(retry ?? fail('Unknown error', 'WORKPOOL_FAILED'), recordsDeferral);
		}

		case 'accepted': {
			if (!outcome.isCustodyHandoff) {
				return plan({
					kind: 'markSent',
					providerMessageId: outcome.providerMessageId,
					providerType: outcome.providerType,
				});
			}
			// Intake is an accepted queue handoff, not remote acceptance. Keep the
			// Send queued so a later stale-route callback can still fail/retry; the
			// transport's sent webhook (or a final relay attempt) owns the terminal
			// edge.
			if (!isQueued) return plan(NONE);
			if (send?.providerMessageId && send.providerMessageId !== outcome.providerMessageId) {
				return plan({ kind: 'refuse', failure: 'delivery.send_identity_conflict' });
			}
			return plan({
				kind: 'recordCustody',
				providerMessageId: outcome.providerMessageId,
				providerType: outcome.providerType,
			});
		}

		// Recipient was on the blocklist at the worker's pre-dispatch suppression
		// re-check — the send was skipped, not delivered. Record a terminal,
		// suppression-labelled non-delivery so campaign stats and the audit trail
		// reflect that this was a deliberate honor-suppression skip (not a
		// provider failure).
		case 'suppressed': {
			const refusal = SUPPRESSED_SEND_FAILURE[outcome.reason ?? 'blocklist'];
			return plan(fail(refusal.message, refusal.code));
		}

		default: {
			// EXHAUSTIVE BY CONSTRUCTION. A sixth arm added to
			// `sendWorkerOutcomeValidator` fails to compile here rather than
			// falling through to a terminal claim about a send nobody read.
			const unhandled: never = outcome;
			throw new InternalFailure('delivery.unhandled_worker_outcome', {
				retryable: false,
				attrs: { outcomeKind: String((unhandled as { kind?: unknown }).kind) },
			});
		}
	}
}

/**
 * The re-entry for a retryable arm, or null once its budget ran out. A replay
 * of a record that kept no envelope refuses rather than re-enter with a stub.
 */
function retryStep(
	outcome: Extract<SendWorkerOutcome, { kind: 'deferred' | 'acceptanceUnknown' }>,
	now: number,
	isEnvelopeStripped: boolean
): CompletionStep | null {
	const delayMs = governedRetryDelayMs(outcome, now);
	if (delayMs === null) return null;
	if (isEnvelopeStripped) return { kind: 'refuse', failure: 'delivery.envelope_not_stored' };
	return {
		kind: 'scheduleRetry',
		delayMs,
		envelopeInput: outcome.envelopeInput,
		retryState: outcome.retryState,
	};
}
