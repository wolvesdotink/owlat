/**
 * Postbox AI callers that fail soft record what a failed structured call was
 * billed for (#1260). `runLlmObject` throws an `LlmPartialUsageError` when every
 * attempt's completion failed the schema; the caller records it once, under the
 * feature its success path uses, and still degrades the way it did before.
 *
 * The dispatch seam and the provider are mocked; the ledger write is observed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	runLlmText: vi.fn(),
	runLlmObject: vi.fn(),
	recordLlmSpend: vi.fn(async () => {}),
}));

vi.mock('../../lib/llm/dispatch', () => ({
	runLlmText: mocks.runLlmText,
	runLlmObject: mocks.runLlmObject,
}));
vi.mock('../../lib/llmProvider', () => ({ resolveLanguageModel: vi.fn(() => 'mock-model') }));
vi.mock('../../analytics/llmUsage', () => ({
	recordLlmSpend: mocks.recordLlmSpend,
	scheduleLlmSpend: vi.fn(async () => {}),
}));

import { scheduleLlmSpend } from '../../analytics/llmUsage';
import { LlmPartialUsageError } from '../../lib/llm/partialUsage';
import { refineClarification } from '../ai/needsReplyClassify';
import { generateCatchUp } from '../ai/catchUpGenerate';

const ctx = {} as never;
const billed = { promptTokens: 30, completionTokens: 15, totalTokens: 45 };
const schemaFailure = () =>
	new LlmPartialUsageError(
		new Error('No object generated: response did not match schema.'),
		billed,
		'mock-model'
	);
/** Rows written under `feature`; a write without usage records nothing (recordLlmSpend). */
const spentUnder = (feature: string) =>
	mocks.recordLlmSpend.mock.calls.filter(
		(call) => (call as unknown[])[1] === feature && (call as unknown[])[2] !== undefined
	);

beforeEach(() => {
	mocks.runLlmText.mockReset();
	mocks.runLlmObject.mockReset();
	mocks.recordLlmSpend.mockClear();
	vi.mocked(scheduleLlmSpend).mockClear();
});

describe('refineClarification — the spend of a failed structured call', () => {
	const opts = { transcript: 'Customer: can you approve the refund?', fromAddress: 'a@acme.test' };

	it('records a failed slot extraction once, under its own feature', async () => {
		mocks.runLlmObject.mockRejectedValueOnce(schemaFailure());

		await expect(refineClarification(ctx, opts)).resolves.toBeUndefined();
		expect(mocks.recordLlmSpend.mock.calls).toEqual([
			[ctx, 'postbox_clarify_slots', billed, 'mock-model'],
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

describe('generateCatchUp — the spend of a failed structured call', () => {
	it('schedules the billed usage the way its success does, and fails soft', async () => {
		mocks.runLlmObject.mockRejectedValueOnce(schemaFailure());

		const card = await generateCatchUp(ctx, {
			entries: [{ label: 'm1', messageId: 'msg-1', side: 'other', text: 'Can you send it?' }],
			mode: 'full',
			locale: 'en',
			feature: 'answer_catch_up',
		});

		expect(card).toBeNull();
		expect(vi.mocked(scheduleLlmSpend).mock.calls).toEqual([
			[ctx, 'answer_catch_up', billed, 'mock-model'],
		]);
		expect(mocks.recordLlmSpend).not.toHaveBeenCalled();
	});
});
