/**
 * The delivery test send's decisions over plain facts: which step comes next,
 * and the answer once one is reached. What the action reads and writes around
 * them is `sendTestWrites.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { nextDeliveryTestStep, type DeliveryTestFacts } from '../deliveryTestDecision';

const configured: DeliveryTestFacts = {
	provider: 'mta',
	isProviderUsable: true,
	to: ' admin@example.com ',
};
const member = {
	...configured,
	recipient: { isRateLimited: false, allowed: ['admin@example.com'] },
};
const withSender: DeliveryTestFacts = {
	...member,
	sender: {
		kind: 'loaded',
		defaultFromEmail: 'ops@owlat.example',
		defaultFromName: 'Owlat Ops',
		defaultFromDomain: undefined,
	},
};
const receipt = { provider: 'mta', providerMessageId: 'msg-1', latencyMs: 12, attempts: 1 };
const accepted: DeliveryTestFacts = {
	...withSender,
	dispatch: { kind: 'accepted', receipt },
};

function statuses(facts: DeliveryTestFacts): string[] {
	const step = nextDeliveryTestStep(facts);
	if (step.kind !== 'answer') throw new Error(`expected an answer, got ${step.kind}`);
	return step.result.stages.map((stage) => stage.status);
}

describe('nextDeliveryTestStep — the order of the steps', () => {
	it('asks for each fact in turn, and only after the one before it passed', () => {
		expect(nextDeliveryTestStep(configured)).toEqual({ kind: 'checkRecipient' });
		expect(nextDeliveryTestStep(member)).toEqual({ kind: 'resolveSender' });
		expect(nextDeliveryTestStep(withSender)).toEqual({
			kind: 'dispatch',
			message: {
				to: 'admin@example.com',
				from: 'Owlat Ops <ops@owlat.example>',
				subject: 'Owlat delivery test',
				html:
					'<p>This is a test email from your Owlat instance.</p>' +
					'<p>If you received it, your delivery provider (<strong>mta</strong>) is working.</p>',
			},
		});
		expect(nextDeliveryTestStep(accepted)).toEqual({ kind: 'record' });
	});

	it('never reaches the roster or the rate limit for an unusable provider or bad address', () => {
		expect(statuses({ ...configured, isProviderUsable: false })).toEqual([
			'failed',
			'not_run',
			'not_run',
			'not_run',
			'not_run',
		]);
		expect(statuses({ ...configured, to: 'nope' })).toEqual([
			'passed',
			'failed',
			'not_run',
			'not_run',
			'not_run',
		]);
	});

	it('stops at the recipient for a rate-limited caller or a non-member address', () => {
		const limited = {
			...configured,
			recipient: { isRateLimited: true, allowed: ['admin@example.com'] },
		};
		const outsider = {
			...configured,
			recipient: { isRateLimited: false, allowed: ['other@example.com'] },
		};
		for (const facts of [limited, outsider]) {
			expect(statuses(facts)).toEqual(['passed', 'failed', 'not_run', 'not_run', 'not_run']);
		}
	});

	it('falls back to the instance noreply sender, and refuses an invalid one', () => {
		const fallback = nextDeliveryTestStep({
			...member,
			sender: {
				kind: 'loaded',
				defaultFromEmail: null,
				defaultFromName: null,
				defaultFromDomain: 'mail.owlat.example',
			},
		});
		expect(fallback).toMatchObject({
			kind: 'dispatch',
			message: { from: 'Owlat <noreply@mail.owlat.example>' },
		});
		expect(statuses({ ...member, sender: { kind: 'unavailable' } })).toEqual([
			'passed',
			'passed',
			'failed',
			'not_run',
			'not_run',
		]);
		expect(
			statuses({
				...member,
				sender: {
					kind: 'loaded',
					defaultFromEmail: 'not-a-sender',
					defaultFromName: null,
					defaultFromDomain: undefined,
				},
			})
		).toEqual(['passed', 'passed', 'failed', 'not_run', 'not_run']);
	});
});

describe('nextDeliveryTestStep — the answer after the send', () => {
	it('reports a refused send without a receipt', () => {
		const step = nextDeliveryTestStep({ ...withSender, dispatch: { kind: 'refused' } });
		expect(step).toMatchObject({
			kind: 'answer',
			result: {
				success: false,
				error: 'Test send failed. Check your provider credentials and the deployment logs.',
				provider: 'mta',
				providerMessageId: null,
			},
		});
	});

	it('carries the receipt whether or not the readiness record landed', () => {
		expect(nextDeliveryTestStep({ ...accepted, recording: 'recorded' })).toMatchObject({
			kind: 'answer',
			result: { success: true, error: null, ...receipt },
		});
		expect(nextDeliveryTestStep({ ...accepted, recording: 'failed' })).toMatchObject({
			kind: 'answer',
			result: {
				success: false,
				error: 'The provider accepted the message, but the readiness result could not be recorded.',
				...receipt,
			},
		});
		expect(statuses({ ...accepted, recording: 'failed' })).toEqual([
			'passed',
			'passed',
			'passed',
			'passed',
			'failed',
		]);
	});

	it('gives the same answer for the same facts and leaves them alone', () => {
		const facts: DeliveryTestFacts = { ...accepted, recording: 'recorded' };
		const snapshot = structuredClone(facts);
		expect(nextDeliveryTestStep(facts)).toEqual(nextDeliveryTestStep(facts));
		expect(facts).toEqual(snapshot);
	});
});
