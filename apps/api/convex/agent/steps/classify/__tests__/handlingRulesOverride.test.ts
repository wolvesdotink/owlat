/**
 * Security tests for the `categorize` handling-rule override inside
 * `classifyStep.execute`.
 *
 * A natural-language handling rule may only ever RESTRICT auto-send, never widen
 * it. A `categorize` rule that relabels a message therefore MUST NOT be able to
 * launder a safety-critical classifier verdict — a genuine `complaint`/`spam`
 * category or an `urgent` priority — into a benign, auto-send-eligible category.
 * Were it allowed, the relabelled category would flow to the route step's
 * inviolable complaint/urgent hard-block and to the per-category autonomy check,
 * moving a held message onto the auto-send path.
 *
 * The LLM classification seam and the deterministic rule evaluation are mocked,
 * so no live model / database is needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlingRuleOutcome } from '../../../../mail/handlingRules/engine';

const runLlmObjectMock = vi.fn();
vi.mock('../../../../lib/llm/dispatch', () => ({
	runLlmObject: (a: unknown) => runLlmObjectMock(a as never),
}));
vi.mock('../../../../lib/llmProvider', () => ({
	getLLMProvider: () => ({}) as never,
}));

import { classifyStep } from '../index';

const inert: HandlingRuleOutcome = {
	matchedInstructions: [],
	autoArchive: false,
	stances: [],
	restrictsAutoSend: false,
	reasons: [],
};

function fakeCtx(outcome: HandlingRuleOutcome) {
	return {
		runQuery: vi.fn(async (_ref: unknown, _args: unknown) => outcome),
	} as never;
}

const input = { inboundMessageId: 'msg1' as never, context: '[CONTEXT]' };

function mockClassification(over: Record<string, unknown> = {}) {
	runLlmObjectMock.mockResolvedValue({
		object: {
			category: 'support',
			priority: 'normal',
			sentiment: 'neutral',
			intent: 'question',
			confidence: 0.9,
			...over,
		},
		tokenUsage: undefined,
		modelUsed: 'mock-model',
	});
}

beforeEach(() => {
	runLlmObjectMock.mockReset();
});

describe('classifyStep.execute — categorize override cannot widen auto-send', () => {
	it('does NOT relabel a genuine complaint (the complaint hard-block is preserved)', async () => {
		mockClassification({ category: 'complaint' });
		const { output } = await classifyStep.execute(
			fakeCtx({ ...inert, categoryOverride: 'support' }),
			input
		);
		expect(output.category).toBe('complaint');
		expect(output.handlingRuleArchive).toBeUndefined();
	});

	it('does NOT relabel a spam classification', async () => {
		mockClassification({ category: 'spam' });
		const { output } = await classifyStep.execute(
			fakeCtx({ ...inert, categoryOverride: 'sales' }),
			input
		);
		expect(output.category).toBe('spam');
	});

	it('does NOT relabel an urgent-priority message', async () => {
		mockClassification({ category: 'support', priority: 'urgent' });
		const { output } = await classifyStep.execute(
			fakeCtx({ ...inert, categoryOverride: 'sales' }),
			input
		);
		expect(output.category).toBe('support');
		expect(output.priority).toBe('urgent');
	});

	it('DOES apply a benign→benign categorize override (legitimate filing)', async () => {
		mockClassification({ category: 'support', priority: 'normal' });
		const { output } = await classifyStep.execute(
			fakeCtx({ ...inert, categoryOverride: 'sales' }),
			input
		);
		expect(output.category).toBe('sales');
	});

	it('an auto_archive rule still short-circuits regardless of category', async () => {
		mockClassification({ category: 'support' });
		const { output } = await classifyStep.execute(
			fakeCtx({ ...inert, autoArchive: true }),
			input
		);
		expect(output.handlingRuleArchive).toBe(true);
	});
});
