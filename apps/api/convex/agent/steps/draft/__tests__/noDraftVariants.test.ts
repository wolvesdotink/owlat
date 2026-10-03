/**
 * The `draft` Agent step writes one draft and no variants (#1200).
 *
 * It used to spend a second capable-tier generation on 2–3 alternative drafts
 * whenever the classifier was unsure or the self-check scored low, and stored
 * them as `draftOptions`. No screen lets a reviewer pick one, so the step now
 * makes exactly two model calls on every path: the draft and its self-check.
 *
 * The LLM dispatch seam and the provider factory are mocked — no live model.
 * The self-check and the old variants call both ran through `runLlmObject`, so
 * its call count is what tells them apart.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeStepCtx } from '../../__tests__/stepCtx';

const mocks = vi.hoisted(() => ({
	runLlmText: vi.fn(),
	runLlmObject: vi.fn(),
	resolveLanguageModel: vi.fn(() => 'mock-model'),
}));

vi.mock('../../../../lib/llm/dispatch', () => ({
	runLlmText: mocks.runLlmText,
	// The primary draft now runs through the tool-calling text seam.
	runLlmTextWithTools: mocks.runLlmText,
	runLlmObject: mocks.runLlmObject,
}));
vi.mock('../../../../lib/llmProvider', () => ({
	resolveLanguageModel: mocks.resolveLanguageModel,
	resolveLanguageModelForClassifiedDraft: mocks.resolveLanguageModel,
}));

import { draftStep, type DraftInput } from '../index';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_1' as Id<'inboundMessages'>;
const DRAFT_TEXT = 'Your order #4821 shipped yesterday and arrives Friday.';

/** Low classifier confidence: the case that used to buy variants. */
const lowConfidenceInput: DraftInput = {
	inboundMessageId: messageId,
	context: 'Customer asks: where is my order #4821?',
	classification: {
		category: 'support',
		priority: 'normal',
		sentiment: 'neutral',
		intent: 'question',
		confidence: 0.5,
	},
};

/** High classifier confidence. */
const highConfidenceInput: DraftInput = {
	...lowConfidenceInput,
	classification: { ...lowConfidenceInput.classification, confidence: 0.95 },
};

function makeCtx() {
	const recorded: Array<Record<string, unknown>> = [];
	const ctx = makeStepCtx<Parameters<typeof draftStep.execute>[0]>({
		queries: {
			getAgentConfig: null,
			getMessage: { subject: 'Order status' }, // no `to` → skip voice
		},
		mutations: {
			recordDraftOutput: (args) => {
				recorded.push(args as Record<string, unknown>);
				return undefined;
			},
			llmUsage: undefined, // spend accounting
		},
	});
	return { ctx, recorded };
}

beforeEach(() => {
	mocks.runLlmText.mockReset();
	mocks.runLlmObject.mockReset();
	mocks.resolveLanguageModel.mockReset();
	mocks.resolveLanguageModel.mockReturnValue('mock-model');
	mocks.runLlmText.mockResolvedValue({
		text: DRAFT_TEXT,
		tokenUsage: undefined,
		modelUsed: 'mock-model',
	});
});

function selfCheck(score: number | null) {
	if (score === null) {
		mocks.runLlmObject.mockRejectedValueOnce(new Error('self-check down'));
		return;
	}
	mocks.runLlmObject.mockResolvedValueOnce({
		object: { score, complete: score >= 0.8, grounded: true, flags: [] },
		tokenUsage: undefined,
		modelUsed: 'mock-model',
	});
}

describe('draftStep.execute — one draft, no variants', () => {
	it.each([
		['low classifier confidence', lowConfidenceInput, 0.95],
		['a low self-check score', highConfidenceInput, 0.5],
		['a failed self-check', highConfidenceInput, null],
		['high confidence and quality', highConfidenceInput, 0.92],
	] as const)('makes no variants call on %s', async (_case, input, score) => {
		selfCheck(score);
		// What the old variants call would have returned, had it been made.
		mocks.runLlmObject.mockResolvedValue({
			object: { replies: ['Short reply.', 'Cautious reply.', 'Detailed reply.'] },
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		});
		const { ctx, recorded } = makeCtx();

		const { output } = await draftStep.execute(ctx, input);

		// The draft, then its self-check. Nothing else.
		expect(mocks.runLlmText).toHaveBeenCalledTimes(1);
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]!['draftResponse']).toBe(DRAFT_TEXT);
		expect('draftOptions' in recorded[0]!).toBe(false);
		expect('draftOptions' in output).toBe(false);
	});
});
