/**
 * Where the Team Inbox draft step's spend lands (#1256, #1259). Every
 * generation writes one `agent_draft` row to the usage ledger, the store the
 * spend ceiling reads: a successful draft, a draft that throws after a paid
 * tool step, and a draft whose output fails to persist afterwards. A successful
 * draft also returns its usage in the step result, which the walker keeps on
 * the step's `agentActions` row as the cost-by-step view; the walker writes no
 * ledger row of its own, so nothing is counted twice.
 *
 * The LLM dispatch seam and the provider factory are mocked (each mocked call
 * records one request on its meter); the spend helper is real, so a ledger row
 * is one request of the `analytics/llmUsage:recordRequests` mutation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeStepCtx } from '../../__tests__/stepCtx';

const mocks = vi.hoisted(() => ({
	runLlmTextWithTools: vi.fn(),
	runLlmText: vi.fn(),
	runLlmObject: vi.fn(),
	resolveLanguageModel: vi.fn(() => 'mock-model'),
}));

vi.mock('../../../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../../../analytics/__tests__/meteredDispatch.testlib');
	return {
		runLlmText: metered((opts: unknown) => mocks.runLlmText(opts)),
		runLlmTextWithTools: metered((opts: unknown) => mocks.runLlmTextWithTools(opts)),
		runLlmObject: metered((opts: unknown) => mocks.runLlmObject(opts)),
	};
});
vi.mock('../../../../lib/llmProvider', () => ({
	resolveLanguageModel: mocks.resolveLanguageModel,
	classifiedDraftRouteOf: () => 'capable',
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
			llmUsage: (args) => {
				const call = args as {
					feature: string;
					requests: Array<{ usage?: unknown; modelUsed?: unknown }>;
				};
				for (const request of call.requests) {
					ledger.push({
						feature: call.feature,
						tokenUsage: request.usage,
						modelUsed: request.modelUsed,
					});
				}
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
	it('writes a successful draft to the ledger once and returns its usage for agentActions', async () => {
		mocks.runLlmTextWithTools.mockResolvedValueOnce({
			text: 'Your order shipped yesterday.',
			tokenUsage: DRAFT_USAGE,
			modelUsed: 'draft-model',
		});
		const { ctx, ledger } = makeCtx();

		const result = await draftStep.execute(ctx, input);

		expect(result.tokenUsage).toEqual(DRAFT_USAGE);
		expect(result.modelUsed).toBe('draft-model');
		expect(ledger).toEqual([
			{ feature: 'agent_draft', tokenUsage: DRAFT_USAGE, modelUsed: 'draft-model' },
			{ feature: 'agent_draft_selfcheck', tokenUsage: CHECK_USAGE, modelUsed: 'check-model' },
		]);
	});

	it('writes the generation to the ledger before the draft goes to the commit', async () => {
		mocks.runLlmTextWithTools.mockResolvedValueOnce({
			text: 'Your order shipped yesterday.',
			tokenUsage: DRAFT_USAGE,
			modelUsed: 'draft-model',
		});
		const { ctx, ledger } = makeCtx();

		// The step records no draft itself (the context has no route for it): the
		// walker's commit stores it. A commit that fails afterwards loses no spend,
		// because the ledger already holds the paid calls.
		const { writes } = await draftStep.execute(ctx, input);
		expect(writes?.map((write) => write.kind)).toEqual(['draft_output']);
		expect(ledger.map((row) => row.feature)).toEqual(['agent_draft', 'agent_draft_selfcheck']);
		expect(ledger[0]!.tokenUsage).toEqual(DRAFT_USAGE);
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
