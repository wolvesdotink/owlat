/**
 * THE WORKER → COMPLETION WIRE, as a shape rather than as a convention.
 *
 * The seam used to be four overlapping optional-boolean shapes plus a fifth
 * that existed only at runtime, cast into place at the consumer. Every case
 * below is one the OLD shape type-checked and the wire now refuses — an
 * acceptance with no message id, a deferral that names no origin, a park
 * carrying an envelope somebody could re-dispatch from — plus the round trip of
 * each arm a producer actually builds.
 */

import { describe, expect, it } from 'vitest';
import { sendSingleEmail } from '../worker';
import {
	isSendWorkerOutcome,
	sendWorkerOutcomeValidator,
	type SendWorkerOutcome,
} from '../workerOutcome';

const envelopeInput = {
	kind: 'campaign',
	to: 'recipient@example.com',
	from: 'sender@example.com',
	template: { subject: 'Subject', htmlContent: '<p>Body</p>' },
	contactInfo: { email: 'recipient@example.com' },
	emailSendId: 'send-row-1',
};
const retryState = { attempt: 1, startedAt: 1_700_000_000_000, idempotencyKey: 'send_send-row-1' };

describe('the five arms a producer builds', () => {
	const arms: Record<string, SendWorkerOutcome> = {
		'accepted — delivered': {
			kind: 'accepted',
			providerMessageId: 'relay-id',
			providerType: 'ses',
			sendLatencyMs: 9,
			isCustodyHandoff: false,
		},
		'accepted — custody handoff': {
			kind: 'accepted',
			providerMessageId: 'send_send-row-1',
			providerType: 'mta',
			sendLatencyMs: 9,
			isCustodyHandoff: true,
		},
		deferred: {
			kind: 'deferred',
			retryAfterMs: 60_000,
			deferralOrigin: 'governed',
			envelopeInput,
			retryState,
		} as SendWorkerOutcome,
		acceptanceUnknown: {
			kind: 'acceptanceUnknown',
			providerMessageId: 'send_send-row-1',
			workAttemptId: 'work-1',
			startedAt: 1_700_000_000_000,
			envelopeInput,
			retryState,
		} as SendWorkerOutcome,
		awaitingFeedback: {
			kind: 'awaitingFeedback',
			providerType: 'mandrill',
			startedAt: 1_700_000_000_000,
			retryState,
		},
		suppressed: { kind: 'suppressed' },
	};

	it.each(Object.entries(arms))('accepts %s', (_label, arm) => {
		expect(isSendWorkerOutcome(arm)).toBe(true);
	});

	it('accepts the optional wait an ambiguous replay may carry', () => {
		expect(isSendWorkerOutcome({ ...arms['acceptanceUnknown'], retryAfterMs: 5_000 })).toBe(true);
	});
});

describe('what the flat-boolean shape let through and the wire does not', () => {
	it.each([
		['the shape a previous build produced', { success: true, providerMessageId: 'msg-1' }],
		['a suppression the type never described', { success: false, suppressed: true }],
		[
			'an acceptance with no message id',
			{ kind: 'accepted', providerType: 'mta', sendLatencyMs: 1, isCustodyHandoff: false },
		],
		[
			'an acceptance that will not say which kind of acceptance it was',
			{ kind: 'accepted', providerMessageId: 'm', providerType: 'mta', sendLatencyMs: 1 },
		],
		[
			'a deferral that names no origin',
			{ kind: 'deferred', retryAfterMs: 1_000, envelopeInput, retryState },
		],
		[
			'a deferral with nothing to re-enter from',
			{ kind: 'deferred', retryAfterMs: 1_000, deferralOrigin: 'governed', retryState },
		],
		[
			'a deferral carrying a partial envelope',
			{
				kind: 'deferred',
				retryAfterMs: 1_000,
				deferralOrigin: 'governed',
				envelopeInput: { kind: 'campaign' },
				retryState,
			},
		],
		[
			// D4, structurally: the park exists BECAUSE the lost response may sit on
			// top of a delivered message. An envelope on this arm is a re-dispatch
			// waiting to happen, and the wire is where that is refused.
			'a park carrying something to re-dispatch from',
			{
				kind: 'awaitingFeedback',
				providerType: 'mandrill',
				startedAt: 1,
				retryState,
				envelopeInput,
			},
		],
		[
			'two arms at once',
			{
				kind: 'deferred',
				retryAfterMs: 1_000,
				deferralOrigin: 'governed',
				envelopeInput,
				retryState,
				acceptanceUnknown: true,
			},
		],
		['an arm this deployment does not know', { kind: 'teleported' }],
		['no discriminant at all', {}],
		['not an object', 'accepted'],
		['nothing', null],
		['nothing, the other way', undefined],
	])('refuses %s', (_label, value) => {
		expect(isSendWorkerOutcome(value)).toBe(false);
	});
});

describe('the worker action is gated on this exact union', () => {
	it('declares it as its returns validator', () => {
		// The gate and the shape the completion callback matches against are the
		// SAME object. Two copies would let the producer widen without the consumer
		// noticing, which is the failure this seam is built to make impossible.
		const declared = (
			sendSingleEmail as unknown as { exportReturns: () => string }
		).exportReturns();
		// `json` is the serialized validator Convex ships to the deployment. It is
		// not on the public `Validator` type, hence the one narrow read here.
		const expected = (sendWorkerOutcomeValidator as unknown as { json: unknown }).json;
		expect(JSON.parse(declared)).toEqual(expected);
	});
});
