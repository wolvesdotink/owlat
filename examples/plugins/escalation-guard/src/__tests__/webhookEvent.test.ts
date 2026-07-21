import { describe, expect, it } from 'vitest';
import {
	buildEscalationEventPayload,
	ESCALATION_EVENT_KIND,
	MAX_EVENT_SIGNALS,
} from '../webhookEvent';
import { detectEscalation, type EscalationSignal } from '../detector';
import { escalationGuardPlugin } from '../manifest';

describe('escalation webhook event', () => {
	it('is namespaced under the plugin id so it cannot shadow a core event', () => {
		expect(ESCALATION_EVENT_KIND).toBe('plugin.escalation-guard.escalation-raised');
		expect(ESCALATION_EVENT_KIND.startsWith('plugin.')).toBe(true);
	});

	it('matches the id declared in the manifest', () => {
		expect(escalationGuardPlugin.contributes.webhookEvents).toEqual([
			{
				id: 'escalation-raised',
				description: 'An inbound message was classified as an escalation.',
				subscribable: true,
			},
		]);
	});

	it('carries the verdict and no mail content', () => {
		const verdict = detectEscalation({
			subject: 'cease and desist',
			textBody: 'we are not renewing',
		});
		const payload = buildEscalationEventPayload(verdict);
		expect(payload).toEqual({
			level: 'escalate',
			signals: ['legal-threat', 'churn'],
			signalCount: 2,
		});
		const serialized = JSON.stringify(payload);
		expect(serialized).not.toContain('cease and desist');
		expect(serialized).not.toContain('renewing');
	});

	it('bounds the signal list while still reporting the true count', () => {
		const signals: EscalationSignal[] = Array.from(
			{ length: MAX_EVENT_SIGNALS + 3 },
			(_, index) => ({ id: `signal-${index}`, level: 'watch' as const })
		);
		const payload = buildEscalationEventPayload({ level: 'watch', signals });
		expect(payload.signals).toHaveLength(MAX_EVENT_SIGNALS);
		expect(payload.signalCount).toBe(MAX_EVENT_SIGNALS + 3);
	});

	it('reports an empty payload for a clean message', () => {
		expect(buildEscalationEventPayload(detectEscalation({ textBody: 'hello' }))).toEqual({
			level: 'none',
			signals: [],
			signalCount: 0,
		});
	});
});
