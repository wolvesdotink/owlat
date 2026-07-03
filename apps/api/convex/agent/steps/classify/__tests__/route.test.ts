/**
 * Pure-function tests for `classifyStep.route` — covers the 3 branches
 * per ADR-0014's drift bug #2.
 */

import { describe, it, expect } from 'vitest';
import { classifyStep, type ClassifyOutput } from '../index';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_test' as Id<'inboundMessages'>;
const runCtx = { inboundMessageId: messageId, agentConfig: null };

function makeOutput(over: Partial<ClassifyOutput> = {}): ClassifyOutput {
	return {
		category: over.category ?? 'support',
		priority: over.priority ?? 'normal',
		sentiment: over.sentiment ?? 'neutral',
		intent: over.intent ?? 'question',
		confidence: over.confidence ?? 0.9,
	};
}

const sampleInput = {
	inboundMessageId: messageId,
	context: '[CONTEXT]',
};

describe('classifyStep.route', () => {
	it('archives spam classifications', () => {
		const route = classifyStep.route(makeOutput({ category: 'spam' }), sampleInput, runCtx);
		expect(route.kind).toBe('transition');
		if (route.kind !== 'transition') return;
		expect(route.transition.to).toBe('archived');
		if (route.transition.to !== 'archived') return;
		expect(route.transition.reason).toBe('classifier_spam');
	});

	it('forks complaints through the clarify step (in-state, not straight to draft_ready)', () => {
		const output = makeOutput({ category: 'complaint' });
		const route = classifyStep.route(output, sampleInput, runCtx);
		expect(route.kind).toBe('in_state');
		if (route.kind !== 'in_state') return;
		expect(route.nextStep).toEqual({
			kind: 'clarify',
			input: {
				inboundMessageId: messageId,
				context: '[CONTEXT]',
				classification: output,
			},
		});
	});

	it('forks urgent messages through the clarify step (in-state)', () => {
		const output = makeOutput({ priority: 'urgent' });
		const route = classifyStep.route(output, sampleInput, runCtx);
		expect(route.kind).toBe('in_state');
		if (route.kind !== 'in_state') return;
		expect(route.nextStep?.kind).toBe('clarify');
	});

	it('routes normal traffic to the clarify step (in-state) before drafting', () => {
		const output = makeOutput({ category: 'support', priority: 'normal' });
		const route = classifyStep.route(output, sampleInput, runCtx);
		expect(route.kind).toBe('in_state');
		if (route.kind !== 'in_state') return;
		expect(route.nextStep).toEqual({
			kind: 'clarify',
			input: {
				inboundMessageId: messageId,
				context: '[CONTEXT]',
				classification: output,
			},
		});
	});
});
