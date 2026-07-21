import { describe, expect, it } from 'vitest';
import type { PluginAgentStepInput } from '@owlat/plugin-kit';
import {
	createEscalationAgentStep,
	escalationAgentStep,
	ESCALATION_REASON_MAX_LENGTH,
} from '../agentStep';
import { escalationGuardPlugin } from '../manifest';

function messageInput(overrides: Partial<PluginAgentStepInput> = {}): PluginAgentStepInput {
	return {
		inboundMessageId: 'msg_1',
		from: 'customer@acme.example',
		to: 'support@owlat.example',
		subject: 'Hello',
		textBody: 'Just checking in.',
		...overrides,
	};
}

describe('escalation agent step', () => {
	it('continues, with the verdict as output, on ordinary mail', async () => {
		const result = await escalationAgentStep.execute(messageInput());
		expect(result).toEqual({ kind: 'continue', output: { level: 'none', signals: [] } });
	});

	it('holds an escalation for human review on the declared edge only', async () => {
		const result = await escalationAgentStep.execute(
			messageInput({ textBody: 'Our attorney will contact you.' })
		);
		expect(result.kind).toBe('caution');
		if (result.kind !== 'caution') throw new Error('expected a caution result');
		expect(result.to).toBe('draft_ready');
		expect(result.reason).toContain('legal-threat');
		expect(result.output).toEqual({ level: 'escalate', signals: ['legal-threat'] });
	});

	it('does not hold a watch-level signal at the default threshold', async () => {
		const result = await escalationAgentStep.execute(
			messageInput({ textBody: 'This is outrageous.' })
		);
		expect(result.kind).toBe('continue');
		expect(result.output).toEqual({ level: 'watch', signals: ['complaint'] });
	});

	it('holds a watch-level signal when configured to', async () => {
		const step = createEscalationAgentStep({ minimumLevel: 'watch' });
		const result = await step.execute(messageInput({ textBody: 'This is outrageous.' }));
		expect(result.kind).toBe('caution');
	});

	it('still continues at the watch threshold when nothing matched', async () => {
		const step = createEscalationAgentStep({ minimumLevel: 'watch' });
		expect((await step.execute(messageInput())).kind).toBe('continue');
	});

	it('never requests a caution target the manifest did not declare', async () => {
		const declaredTargets = new Set<string>(
			escalationGuardPlugin.contributes.agentSteps.flatMap((step) =>
				step.lifecycleEdges.map((edge) => edge.to)
			)
		);
		const bodies = [
			'Our lawyer will call.',
			'GDPR complaint incoming.',
			'We are issuing a chargeback.',
			'Cancel our contract, this is outrageous.',
		];
		for (const textBody of bodies) {
			const result = await escalationAgentStep.execute(messageInput({ textBody }));
			if (result.kind === 'caution') expect(declaredTargets.has(result.to)).toBe(true);
		}
		expect(declaredTargets).toEqual(new Set(['draft_ready']));
	});

	it('bounds the reason string it hands back to the host', async () => {
		const result = await escalationAgentStep.execute(
			messageInput({
				subject: 'cease and desist / gdpr complaint / chargeback',
				textBody: 'not renewing, formal complaint',
			})
		);
		expect(result.kind).toBe('caution');
		if (result.kind !== 'caution') throw new Error('expected a caution result');
		expect(result.reason.length).toBeLessThanOrEqual(ESCALATION_REASON_MAX_LENGTH);
	});

	it('reads the html body when there is no text body', async () => {
		const result = await escalationAgentStep.execute(
			messageInput({ textBody: undefined, htmlBody: '<p>legal action follows</p>' })
		);
		expect(result.kind).toBe('caution');
	});
});
