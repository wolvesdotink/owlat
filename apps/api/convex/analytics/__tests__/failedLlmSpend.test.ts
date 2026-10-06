/**
 * `recordSpendOnFailure` (analytics/failedLlmSpend.ts, #1260): a caller that
 * ends a dispatch failure itself records what the provider billed, once, and
 * its catch still sees the provider's original error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../llmUsage', () => ({ recordLlmSpend: vi.fn(async () => {}) }));

import { recordLlmSpend } from '../llmUsage';
import { recordSpendOnFailure } from '../failedLlmSpend';
import { LlmPartialUsageError } from '../../lib/llm/partialUsage';

const ctx = {} as never;
const usage = { promptTokens: 30, completionTokens: 15, totalTokens: 45 };

beforeEach(() => {
	vi.mocked(recordLlmSpend).mockClear();
});

describe('recordSpendOnFailure', () => {
	it('records a billed failure once and rethrows the original error', async () => {
		const original = new Error('No object generated: response did not match schema.');
		const error = await recordSpendOnFailure(
			ctx,
			'postbox_category',
			Promise.reject(new LlmPartialUsageError(original, usage, 'model-a'))
		).catch((e: unknown) => e);

		expect(error).toBe(original);
		expect(vi.mocked(recordLlmSpend).mock.calls).toEqual([
			[ctx, 'postbox_category', usage, 'model-a'],
		]);
	});

	it('records nothing for a failure that was never billed', async () => {
		const original = Object.assign(new Error('unauthorized'), { statusCode: 401 });
		const error = await recordSpendOnFailure(ctx, 'translate', Promise.reject(original)).catch(
			(e: unknown) => e
		);

		expect(error).toBe(original);
		expect(recordLlmSpend).not.toHaveBeenCalled();
	});

	it('leaves a success to the caller', async () => {
		const result = { object: { ok: true }, tokenUsage: usage, modelUsed: 'model-a' };

		await expect(recordSpendOnFailure(ctx, 'translate', Promise.resolve(result))).resolves.toBe(
			result
		);
		expect(recordLlmSpend).not.toHaveBeenCalled();
	});

	it('writes through the writer it is given', async () => {
		const write = vi.fn(async () => {});
		const original = new Error('schema');
		await recordSpendOnFailure(
			ctx,
			'answer_catch_up',
			Promise.reject(new LlmPartialUsageError(original, usage, 'model-a')),
			write
		).catch(() => undefined);

		expect(write).toHaveBeenCalledWith(ctx, 'answer_catch_up', usage, 'model-a');
		expect(recordLlmSpend).not.toHaveBeenCalled();
	});

	it('still rethrows the dispatch error when the ledger write fails', async () => {
		vi.mocked(recordLlmSpend).mockRejectedValueOnce(new Error('ledger down'));
		const original = new Error('schema');
		const error = await recordSpendOnFailure(
			ctx,
			'postbox_commitment',
			Promise.reject(new LlmPartialUsageError(original, usage, 'model-a'))
		).catch((e: unknown) => e);

		expect(error).toBe(original);
	});
});
