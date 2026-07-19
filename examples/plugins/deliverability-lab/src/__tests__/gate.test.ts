import type { PluginAutonomyGateInput } from '@owlat/plugin-kit';
import { describe, expect, it } from 'vitest';
import { createDeliverabilityGate, deliverabilityGate } from '../gate';
import type { RemoteScoreHook } from '../remoteScore';
import { BROKEN_LINKS_EMAIL, CLEAN_EMAIL, SPAMMY_EMAIL } from './fixtures';
import type { DeliverabilityEmail } from '../engine';

function draft(email: DeliverabilityEmail): PluginAutonomyGateInput {
	return {
		from: email.from,
		to: 'recipient@example.com',
		subject: email.subject,
		draftBody: email.html ?? email.text ?? '',
	};
}

const services = () => ({ signal: new AbortController().signal });

describe('deliverability send gate (Tier 1, restrict-only)', () => {
	it('raises no objection to a clean draft', async () => {
		const result = await deliverabilityGate.evaluate(draft(CLEAN_EMAIL), services());
		expect(result).toEqual({ outcome: 'no-objection' });
	});

	it.each([
		['spammy', SPAMMY_EMAIL],
		['broken-links', BROKEN_LINKS_EMAIL],
	])('objects to a %s draft and never approves', async (_label, email) => {
		const result = await deliverabilityGate.evaluate(draft(email), services());
		expect(result.outcome).toBe('objection');
		expect(result).toHaveProperty('reason');
	});

	it('fails closed to an objection when its own analysis throws', async () => {
		const hostile = {
			from: 'a@b.example',
			to: 'c@d.example',
			subject: 'hi',
			get draftBody(): string {
				throw new Error('boom');
			},
		} as unknown as PluginAutonomyGateInput;
		const result = await deliverabilityGate.evaluate(hostile, services());
		expect(result.outcome).toBe('objection');
	});
});

describe('deliverability send gate + Tier-2 seedbox escalation', () => {
	it('escalates an otherwise-clean draft to a hold when the seedbox scores it high', async () => {
		const hook: RemoteScoreHook = async () => ({ score: 0.95, reason: 'known spam template' });
		const gate = createDeliverabilityGate({ remoteScoreHook: hook, remoteDeadlineMs: 5_000 });
		const result = await gate.evaluate(draft(CLEAN_EMAIL), services());
		expect(result.outcome).toBe('objection');
		if (result.outcome === 'objection') {
			expect(result.reason).toContain('Seedbox');
		}
	});

	it('does not escalate when the seedbox score is below threshold', async () => {
		const hook: RemoteScoreHook = async () => ({ score: 0.1 });
		const gate = createDeliverabilityGate({ remoteScoreHook: hook, remoteDeadlineMs: 5_000 });
		const result = await gate.evaluate(draft(CLEAN_EMAIL), services());
		expect(result).toEqual({ outcome: 'no-objection' });
	});

	it('falls back to local scoring (still no false objection) when the seedbox fails', async () => {
		const hook: RemoteScoreHook = async () => {
			throw new Error('vendor down');
		};
		const gate = createDeliverabilityGate({ remoteScoreHook: hook, remoteDeadlineMs: 5_000 });
		const result = await gate.evaluate(draft(CLEAN_EMAIL), services());
		expect(result).toEqual({ outcome: 'no-objection' });
	});
});
