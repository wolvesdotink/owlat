/**
 * The send completion's decisions over plain objects: one worker answer, the
 * Send row the handler loaded and an injected clock in, one plan out. What the
 * handler then writes is `applyCompletionWrites.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import type { Id } from '../../_generated/dataModel';
import {
	completionReadsSend,
	planCompletionOutcome,
	readCompletion,
	type CompletionSendState,
} from '../sendCompletionDecision';
import type { SendWorkerOutcome } from '../workerOutcome';

const NOW = 1_800_000_000_000;
const EXPIRED = NOW - GOVERNED_MTA_MAX_MESSAGE_AGE_MS - 1;
const SEND_ID = 'send_1' as Id<'emailSends'>;
const QUEUED: CompletionSendState = { status: 'queued' };

const envelopeInput = {
	kind: 'campaign' as const,
	to: 'recipient@example.com',
	from: 'sender@example.com',
	template: { subject: 'Subject', htmlContent: '<p>Body</p>' },
	contactInfo: { email: 'recipient@example.com' },
	emailSendId: SEND_ID,
};
const retryState = (startedAt: number, attempt = 1) => ({
	attempt,
	startedAt,
	idempotencyKey: `send_${SEND_ID}`,
});

const deferred = (
	deferralOrigin: 'governed' | 'local',
	state = retryState(NOW, 2)
): SendWorkerOutcome => ({
	kind: 'deferred',
	retryAfterMs: 60_000,
	deferralOrigin,
	envelopeInput,
	retryState: state,
});
const acceptanceUnknown = (startedAt: number): SendWorkerOutcome => ({
	kind: 'acceptanceUnknown',
	providerMessageId: 'mta-1',
	workAttemptId: 'attempt-1',
	startedAt,
	envelopeInput,
	retryState: retryState(startedAt),
	retryAfterMs: 120_000,
});
const awaitingFeedback = (startedAt: number, stateStartedAt = startedAt): SendWorkerOutcome => ({
	kind: 'awaitingFeedback',
	providerType: 'mandrill',
	startedAt,
	retryState: retryState(stateStartedAt),
});
const accepted = (isCustodyHandoff: boolean): SendWorkerOutcome => ({
	kind: 'accepted',
	providerMessageId: 'msg-1',
	providerType: 'ses',
	sendLatencyMs: 5,
	isCustodyHandoff,
});

function planFor(
	outcome: SendWorkerOutcome,
	options: { send?: CompletionSendState | null; isEnvelopeStripped?: boolean; now?: number } = {}
) {
	return planCompletionOutcome({
		outcome,
		send: options.send === undefined ? QUEUED : options.send,
		now: options.now ?? NOW,
		isEnvelopeStripped: options.isEnvelopeStripped ?? false,
	});
}

describe('readCompletion', () => {
	it('decides a run without an outcome as WORKPOOL_FAILED', () => {
		expect(readCompletion({ kind: 'failed', error: 'boom' })).toEqual({
			kind: 'decided',
			plan: {
				recordsDeferral: false,
				step: { kind: 'fail', errorMessage: 'boom', errorCode: 'WORKPOOL_FAILED' },
			},
		});
		expect(readCompletion({ kind: 'canceled' })).toMatchObject({
			plan: { step: { errorMessage: 'Unknown error', errorCode: 'WORKPOOL_FAILED' } },
		});
	});

	it('names an unreadable answer by its shape, never its contents', () => {
		const reading = readCompletion({
			kind: 'success',
			returnValue: { kind: 'delivered', to: 'person@example.com' },
		});
		expect(reading).toMatchObject({
			kind: 'decided',
			plan: { step: { kind: 'fail', errorCode: 'WORKER_RESULT_MALFORMED' } },
			unreadableShape: 'kind=delivered keys=[kind,to]',
		});
		expect(JSON.stringify(reading)).not.toContain('person@example.com');
	});

	it('passes a readable outcome on to the second stage', () => {
		expect(readCompletion({ kind: 'success', returnValue: accepted(false) })).toEqual({
			kind: 'outcome',
			outcome: accepted(false),
		});
	});
});

describe('completionReadsSend', () => {
	it('loads the Send only for the arms that decide on it', () => {
		expect(completionReadsSend(awaitingFeedback(NOW))).toBe(true);
		expect(completionReadsSend(acceptanceUnknown(NOW))).toBe(true);
		expect(completionReadsSend(accepted(true))).toBe(true);
		expect(completionReadsSend(accepted(false))).toBe(false);
		expect(completionReadsSend(deferred('governed'))).toBe(false);
		expect(completionReadsSend({ kind: 'suppressed' })).toBe(false);
	});
});

describe('planCompletionOutcome', () => {
	it('parks an awaitingFeedback send until the deadline of its first attempt', () => {
		expect(planFor(awaitingFeedback(NOW - 5, NOW - 9)).step).toEqual({
			kind: 'scheduleExpiry',
			runAt: NOW - 9 + GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
			startedAt: NOW - 9,
		});
		expect(planFor(awaitingFeedback(NOW + 1_000)).step).toMatchObject({ startedAt: NOW });
		expect(planFor(awaitingFeedback(EXPIRED)).step).toEqual({
			kind: 'expireNow',
			startedAt: EXPIRED,
		});
	});

	it('falls back to the arm copy, then the clock, for an unreadable start', () => {
		expect(planFor(awaitingFeedback(NOW - 7, Number.NaN)).step).toMatchObject({
			startedAt: NOW - 7,
		});
		expect(planFor(awaitingFeedback(Number.NaN, Number.NaN)).step).toMatchObject({
			startedAt: NOW,
		});
	});

	it('writes nothing for a Send that is gone or settled', () => {
		for (const send of [null, { status: 'sent' }]) {
			for (const outcome of [awaitingFeedback(NOW), acceptanceUnknown(NOW), accepted(true)]) {
				expect(planFor(outcome, { send }).step).toEqual({ kind: 'none' });
			}
		}
	});

	it('replays an open acceptance, and closes it by message id past the deadline', () => {
		expect(planFor(acceptanceUnknown(NOW)).step).toEqual({
			kind: 'scheduleRetry',
			delayMs: 120_000,
			envelopeInput,
			retryState: retryState(NOW),
		});
		expect(planFor(acceptanceUnknown(EXPIRED)).step).toEqual({
			kind: 'failByProviderMessageId',
			providerMessageId: 'mta-1',
			errorMessage: 'MTA intake acceptance could not be confirmed before the delivery deadline',
			errorCode: 'MTA_ACCEPTANCE_UNCONFIRMED',
		});
	});

	it('refuses a re-entry without a stored envelope, but not a terminal one', () => {
		const stripped = { isEnvelopeStripped: true };
		expect(planFor(acceptanceUnknown(NOW), stripped).step).toEqual({
			kind: 'refuse',
			failure: 'delivery.envelope_not_stored',
		});
		expect(planFor(deferred('local'), stripped).step).toMatchObject({ kind: 'refuse' });
		expect(planFor(acceptanceUnknown(EXPIRED), stripped).step.kind).toBe('failByProviderMessageId');
		expect(planFor(deferred('local', retryState(NOW, 9)), stripped).step.kind).toBe('fail');
	});

	it('records only a governed deferral, also the one that terminalizes', () => {
		expect(planFor(deferred('governed'))).toEqual({
			recordsDeferral: true,
			step: {
				kind: 'scheduleRetry',
				delayMs: 60_000,
				envelopeInput,
				retryState: retryState(NOW, 2),
			},
		});
		expect(planFor(deferred('local')).recordsDeferral).toBe(false);
		expect(planFor(deferred('governed', retryState(NOW, 9)))).toEqual({
			recordsDeferral: true,
			step: { kind: 'fail', errorMessage: 'Unknown error', errorCode: 'WORKPOOL_FAILED' },
		});
	});

	it('marks a direct acceptance sent and records a custody handoff', () => {
		expect(planFor(accepted(false), { send: null }).step).toEqual({
			kind: 'markSent',
			providerMessageId: 'msg-1',
			providerType: 'ses',
		});
		expect(planFor(accepted(true)).step).toEqual({
			kind: 'recordCustody',
			providerMessageId: 'msg-1',
			providerType: 'ses',
		});
		expect(
			planFor(accepted(true), { send: { status: 'queued', providerMessageId: 'msg-1' } }).step.kind
		).toBe('recordCustody');
		expect(
			planFor(accepted(true), { send: { status: 'queued', providerMessageId: 'msg-2' } }).step
		).toEqual({ kind: 'refuse', failure: 'delivery.send_identity_conflict' });
	});

	it('labels each pre-dispatch refusal with its own code', () => {
		expect(planFor({ kind: 'suppressed' }).step).toMatchObject({
			errorCode: 'RECIPIENT_SUPPRESSED',
		});
		expect(planFor({ kind: 'suppressed', reason: 'contact_unsubscribed' }).step).toMatchObject({
			errorCode: 'RECIPIENT_UNSUBSCRIBED',
		});
		expect(planFor({ kind: 'suppressed', reason: 'contact_deleted' }).step).toMatchObject({
			errorCode: 'CONTACT_DELETED',
		});
	});

	it('gives the same plan for the same input and leaves the input alone', () => {
		const input = {
			outcome: deferred('governed'),
			send: QUEUED,
			now: NOW,
			isEnvelopeStripped: false,
		};
		const snapshot = structuredClone(input);
		expect(planCompletionOutcome(input)).toEqual(planCompletionOutcome(input));
		expect(input).toEqual(snapshot);
	});
});
