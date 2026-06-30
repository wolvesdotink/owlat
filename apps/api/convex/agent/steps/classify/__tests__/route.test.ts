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

	it('escalates complaints to draft_ready (skipping drafter)', () => {
		const route = classifyStep.route(makeOutput({ category: 'complaint' }), sampleInput, runCtx);
		expect(route.kind).toBe('transition');
		if (route.kind !== 'transition') return;
		expect(route.transition.to).toBe('draft_ready');
		expect(route.nextStep).toBeUndefined();
	});

	it('escalates urgent messages to draft_ready (skipping drafter)', () => {
		const route = classifyStep.route(makeOutput({ priority: 'urgent' }), sampleInput, runCtx);
		expect(route.kind).toBe('transition');
		if (route.kind !== 'transition') return;
		expect(route.transition.to).toBe('draft_ready');
	});

	it('routes normal traffic to drafting + schedules the draft step', () => {
		const output = makeOutput({ category: 'support', priority: 'normal' });
		const route = classifyStep.route(output, sampleInput, runCtx);
		expect(route.kind).toBe('transition');
		if (route.kind !== 'transition') return;
		expect(route.transition.to).toBe('drafting');
		if (route.transition.to !== 'drafting') return;
		expect(route.transition.classification).toEqual(output);
		expect(route.nextStep).toEqual({
			kind: 'draft',
			input: {
				inboundMessageId: messageId,
				context: '[CONTEXT]',
				classification: output,
			},
		});
	});
});
