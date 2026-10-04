/**
 * Where the Team Inbox draft step's spend lands (#1256). A successful draft
 * returns its usage in the step result, which the walker stores on the step's
 * `agentActions` row (the cost-by-step view); it writes no `agent_draft` ledger
 * row, so the two stores never hold the same call. A draft that throws after
 * a paid tool step fails the step, and the walker's failed transition carries
 * no usage, so that spend goes to the ledger under `agent_draft`, once.
 *
 * The LLM dispatch seam and the provider factory are mocked; the spend helper
 * is real, so the ledger write is the `analytics/llmUsage:record` mutation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeStepCtx } from '../../__tests__/stepCtx';

const mocks = vi.hoisted(() => ({
	runLlmTextWithTools: vi.fn(),
	runLlmText: vi.fn(),
	runLlmObject: vi.fn(),
	resolveLanguageModel: vi.fn(() => 'mock-model'),
}));

vi.mock('../../../../lib/llm/dispatch', () => ({
	runLlmText: mocks.runLlmText,
	runLlmTextWithTools: mocks.runLlmTextWithTools,
	runLlmObject: mocks.runLlmObject,
}));
vi.mock('../../../../lib/llmProvider', () => ({
	resolveLanguageModel: mocks.resolveLanguageModel,
	resolveLanguageModelForClassifiedDraft: mocks.resolveLanguageModel,
}));

import { draftStep, type DraftInput } from '../index';
import { LlmPartialUsageError } from '../../../../lib/llm/partialUsage';
import type { Id } from '../../../../_generated/dataModel';

const input: DraftInput = {
	inboundMessageId: 'msg_1' as Id<'inboundMessages'>,
	context: 'Customer asks: where is my order #4821?',
	classification: {
		category: 'support',
		priority: 'normal',
		sentiment: 'neutral',
		intent: 'question',
		confidence: 0.9,
	},
};

const DRAFT_USAGE = { promptTokens: 40, completionTokens: 20, totalTokens: 60 };
const CHECK_USAGE = { promptTokens: 4, completionTokens: 2, totalTokens: 6 };

function makeCtx() {
	const ledger: Array<{ feature: string; tokenUsage: unknown; modelUsed: unknown }> = [];
	const ctx = makeStepCtx<Parameters<typeof draftStep.execute>[0]>({
		queries: {
			getAgentConfig: null,
			getMessage: { subject: 'Order status' }, // no `to` → skip voice
			evaluateForMessage: { stances: [] },
		},
		mutations: {
			recordDraftOutput: undefined,
			llmUsage: (args) => {
				ledger.push(args as (typeof ledger)[number]);
				return undefined;
			},
		},
	});
	return { ctx, ledger };
}

beforeEach(() => {
	mocks.runLlmTextWithTools.mockReset();
	mocks.runLlmText.mockReset();
	mocks.runLlmObject.mockReset();
	mocks.runLlmObject.mockResolvedValue({
		object: { score: 0.9, complete: true, grounded: true, flags: [] },
		tokenUsage: CHECK_USAGE,
		modelUsed: 'check-model',
	});
});

describe('draftStep.execute — draft spend (#1256)', () => {
	it('returns a successful draft’s usage for agentActions and writes no agent_draft row', async () => {
		mocks.runLlmTextWithTools.mockResolvedValueOnce({
			text: 'Your order shipped yesterday.',
			tokenUsage: DRAFT_USAGE,
			modelUsed: 'draft-model',
		});
		const { ctx, ledger } = makeCtx();

		const result = await draftStep.execute(ctx, input);

		expect(result.tokenUsage).toEqual(DRAFT_USAGE);
		expect(result.modelUsed).toBe('draft-model');
		expect(ledger.map((row) => row.feature)).toEqual(['agent_draft_selfcheck']);
	});

	it('records the paid tool steps of a draft that throws in the ledger, once', async () => {
		const error = new LlmPartialUsageError(new Error('provider down'), DRAFT_USAGE, 'draft-model');
		mocks.runLlmTextWithTools.mockRejectedValueOnce(error);
		const { ctx, ledger } = makeCtx();

		// The walker turns the throw into a failed step, with the original message.
		await expect(draftStep.execute(ctx, input)).rejects.toThrow('provider down');
		expect(ledger).toEqual([
			{ feature: 'agent_draft', tokenUsage: DRAFT_USAGE, modelUsed: 'draft-model' },
		]);
	});
});
