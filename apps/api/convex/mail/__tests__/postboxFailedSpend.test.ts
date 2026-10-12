/**
 * Postbox AI callers that fail soft record what a failed structured call was
 * billed for (#1260). `runLlmObject` throws an `LlmPartialUsageError` when every
 * attempt's completion failed the schema; the meter records it once, under the
 * feature its success path uses, and the caller still degrades the way it did
 * before.
 *
 * The dispatch seam and the provider are mocked (each mocked call records one
 * request on its meter); the ledger write is observed on the ctx.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	runLlmText: vi.fn(),
	runLlmObject: vi.fn(),
	runMutation: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
}));

vi.mock('../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../analytics/__tests__/meteredDispatch.testlib');
	return {
		runLlmText: metered((opts: unknown) => mocks.runLlmText(opts)),
		runLlmObject: metered((opts: unknown) => mocks.runLlmObject(opts)),
	};
});
vi.mock('../../lib/llmProvider', () => ({ resolveLanguageModel: vi.fn(() => 'mock-model') }));

import { ledgerRows } from '../../analytics/__tests__/meteredDispatch.testlib';
import { LlmPartialUsageError } from '../../lib/llm/partialUsage';
import { refineClarification } from '../ai/needsReplyClassify';

const ctx = { runMutation: mocks.runMutation } as never;
const billed = { promptTokens: 30, completionTokens: 15, totalTokens: 45 };
const schemaFailure = () =>
	new LlmPartialUsageError(
		new Error('No object generated: response did not match schema.'),
		billed,
		'mock-model'
	);
/** Billed rows written under `feature`, as [ctx, feature, usage, model]. */
const spentUnder = (feature: string) =>
	ledgerRows(mocks.runMutation)
		.filter((row) => row.feature === feature && row.usage !== undefined)
		.map((row) => [ctx, row.feature, row.usage, row.modelUsed]);

beforeEach(() => {
	mocks.runLlmText.mockReset();
	mocks.runLlmObject.mockReset();
	mocks.runMutation.mockClear();
});

describe('refineClarification — the spend of a failed structured call', () => {
	const opts = { transcript: 'Customer: can you approve the refund?', fromAddress: 'a@acme.test' };

	it('records a failed slot extraction once, under its own feature', async () => {
		mocks.runLlmObject.mockRejectedValueOnce(schemaFailure());

		await expect(refineClarification(ctx, opts)).resolves.toBeUndefined();
		expect(ledgerRows(mocks.runMutation).map((row) => [row.feature, row.usage])).toEqual([
			['postbox_clarify_slots', billed],
		]);
	});

	it('records a failed divergence judgment under the divergence feature', async () => {
		mocks.runLlmObject
			.mockResolvedValueOnce({
				object: {
					slots: [
						{
							slotType: 'decision',
							question: 'Should we approve the refund?',
							answerableFromContext: false,
							decisionRelevant: true,
						},
					],
				},
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			})
			.mockRejectedValueOnce(schemaFailure());
		mocks.runLlmText.mockResolvedValue({
			text: 'A candidate reply.',
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		});

		await expect(refineClarification(ctx, opts)).resolves.toBeUndefined();
		expect(spentUnder('postbox_clarify_diverge')).toEqual([
			[ctx, 'postbox_clarify_diverge', billed, 'mock-model'],
		]);
		expect(spentUnder('postbox_clarify_slots')).toEqual([]);
	});

	it('records nothing for a failure that was never billed', async () => {
		mocks.runLlmObject.mockRejectedValueOnce(new Error('401 unauthorized'));

		await expect(refineClarification(ctx, opts)).resolves.toBeUndefined();
		expect(spentUnder('postbox_clarify_slots')).toEqual([]);
	});
});
