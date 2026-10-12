import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../../_generated/server';
import type { IndexEmbedder } from '../../llmProvider';
import { storedEmbeddingTarget } from '../../embeddingSpace';

const admission = vi.hoisted(() => ({ requests: 0, settled: [] as number[], isAdmitting: true }));
vi.mock('../embeddingAdmission', () => ({
	admitPaidEmbeddingBatch: vi.fn(async () => {
		admission.requests += 1;
		if (!admission.isAdmitting) return { isAdmitted: false, reason: 'refused' };
		return {
			isAdmitted: true,
			settle: async (usage: { dispatchedCalls: number }) => {
				admission.settled.push(usage.dispatchedCalls);
			},
		};
	}),
}));

import { runAdmittedEmbedding } from '../embeddingDispatch';

const ctx = {} as ActionCtx;
const batch = {
	rootRequestId: 'root',
	task: 'embedding.index' as const,
	jobKind: 'reembed' as const,
	items: 2,
	inputChars: 10,
};
const embedder = (kind: 'local' | 'openai'): IndexEmbedder => ({
	model: 'model' as unknown as IndexEmbedder['model'],
	target: storedEmbeddingTarget({ embeddingProviderKind: kind }),
});

beforeEach(() => {
	admission.requests = 0;
	admission.settled = [];
	admission.isAdmitting = true;
});

describe('runAdmittedEmbedding', () => {
	it('admits by the embedder about to be called, whatever the caller thought (F12)', async () => {
		const run = vi.fn(async () => 'ok');
		// A caller that believed the work was free: the hosted embedder still needs admission.
		await runAdmittedEmbedding(ctx, embedder('openai'), batch, run, { isPaid: false });
		expect(admission.requests).toBe(1);
		admission.isAdmitting = false;
		const refused = await runAdmittedEmbedding(ctx, embedder('openai'), batch, run);
		expect(refused).toEqual({ isAdmitted: false, reason: 'refused' });
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('runs a local embedder without admission, unless the job is paid', async () => {
		await runAdmittedEmbedding(ctx, embedder('local'), batch, async () => 'ok');
		expect(admission.requests).toBe(0);
		await runAdmittedEmbedding(ctx, embedder('local'), batch, async () => 'ok', { isPaid: true });
		expect(admission.requests).toBe(1);
	});

	it('settles exactly once with the calls started, also when the run throws (F15)', async () => {
		await expect(
			runAdmittedEmbedding(ctx, embedder('openai'), batch, async (counter) => {
				counter.dispatched += 2;
				throw new Error('search failed');
			})
		).rejects.toThrow('search failed');
		expect(admission.settled).toEqual([2]);
	});
});
