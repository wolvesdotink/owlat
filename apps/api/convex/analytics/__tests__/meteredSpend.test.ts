/**
 * The single owner of a metered call's ledger rows (`analytics/meteredSpend.ts`):
 * every provider request the dispatch recorded is written once, on
 * success and on failure, and nothing is written for a call that never reached
 * a provider.
 */

import { describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { meterFor, meterLlmCall, persistMeteredSpend } from '../meteredSpend';
import { LlmPartialUsageError } from '../../lib/llm/partialUsage';
import type { LlmCallMeter } from '../../lib/llm/requestMeter';
import { ledgerRows } from './meteredDispatch.testlib';
import { MAX_METERED_REQUESTS_PER_WRITE } from '../llmUsage';
import { anchorActionDeadline } from '../../lib/llm/actionDeadline';

const usage = (n: number) => ({ promptTokens: n, completionTokens: n, totalTokens: 2 * n });

function fakeCtx() {
	const runMutation = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
	const runAfter = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
	return { ctx: { runMutation, scheduler: { runAfter } } as never, runMutation, runAfter };
}

/** A dispatch that made `count` provider requests, the last one answering. */
function requests(meter: LlmCallMeter, count: number) {
	for (let attempt = 1; attempt < count; attempt++) {
		meter.record({ outcome: 'failed', latencyMs: 10 });
	}
	meter.record({ outcome: 'ok', latencyMs: 20, usage: usage(5), modelUsed: 'm' });
	return { value: 'answer', tokenUsage: usage(5), modelUsed: 'm' };
}

describe('meterLlmCall', () => {
	it('writes one row per provider request, with the call’s task and root', async () => {
		const { ctx, runMutation } = fakeCtx();
		const result = await meterLlmCall(
			ctx,
			{ feature: 'agent_classify', root: { rootRequestId: 'team:m1' } },
			async (meter) => requests(meter, 3)
		);

		expect(result.value).toBe('answer');
		expect(runMutation).toHaveBeenCalledTimes(1);
		expect(getFunctionName(runMutation.mock.calls[0]![0] as never)).toBe(
			'analytics/llmUsage:recordRequests'
		);
		const rows = ledgerRows(runMutation);
		expect(rows.map((row) => [row.attempt, row.usage])).toEqual([
			[1, undefined],
			[2, undefined],
			[3, usage(5)],
		]);
		for (const row of rows) {
			expect(row).toMatchObject({
				feature: 'agent_classify',
				task: 'mail.classify',
				plane: 'language',
				rootRequestId: 'team:m1',
			});
		}
		expect(new Set(rows.map((row) => row.requestId)).size).toBe(1);
	});

	it('writes a failed call’s requests, then rethrows the provider’s own error', async () => {
		const { ctx, runMutation } = fakeCtx();
		const cause = new Error('schema mismatch');
		await expect(
			meterLlmCall(ctx, { feature: 'interpret' }, async (meter) => {
				meter.record({ outcome: 'failed', latencyMs: 1, usage: usage(3) });
				throw new LlmPartialUsageError(cause, usage(3), 'm');
			})
		).rejects.toBe(cause);
		expect(ledgerRows(runMutation).map((row) => row.usage)).toEqual([usage(3)]);
	});

	it('can rethrow the partial-usage error as is, for a caller that reads it', async () => {
		const { ctx } = fakeCtx();
		const error = new LlmPartialUsageError(new Error('down'), usage(1), 'm');
		await expect(
			meterLlmCall(ctx, { feature: 'interpret' }, async () => Promise.reject(error), {
				rethrow: 'as_is',
			})
		).rejects.toBe(error);
	});

	it('writes nothing for a call that never reached a provider', async () => {
		const { ctx, runMutation } = fakeCtx();
		await expect(
			meterLlmCall(ctx, { feature: 'interpret' }, async () => {
				throw new Error('model not configured');
			})
		).rejects.toThrow('model not configured');
		expect(runMutation).not.toHaveBeenCalled();
	});

	it('schedules the write for an interactive surface instead of running it inline', async () => {
		const { ctx, runMutation, runAfter } = fakeCtx();
		await meterLlmCall(ctx, { feature: 'postbox_complete_draft' }, async (m) => requests(m, 1), {
			write: 'schedule',
		});
		expect(runMutation).not.toHaveBeenCalled();
		expect(runAfter).toHaveBeenCalledWith(0, expect.anything(), expect.anything());
		expect(ledgerRows(runAfter)).toHaveLength(1);
	});

	it('fails the call only when no write path stored its rows, unless told to keep the result', async () => {
		const failing = fakeCtx();
		failing.runMutation.mockRejectedValue(new Error('ledger down'));
		failing.runAfter.mockRejectedValue(new Error('scheduler down'));
		await expect(
			meterLlmCall(failing.ctx, { feature: 'translate' }, async (m) => requests(m, 1))
		).rejects.toThrow('scheduler down');

		const tolerant = fakeCtx();
		tolerant.runMutation.mockRejectedValue(new Error('ledger down'));
		tolerant.runAfter.mockRejectedValue(new Error('scheduler down'));
		await expect(
			meterLlmCall(tolerant.ctx, { feature: 'translate' }, async (m) => requests(m, 1), {
				onWriteError: 'ignore',
			})
		).resolves.toMatchObject({ value: 'answer' });
	});

	it('keeps the provider error when the failure-path write also fails', async () => {
		const { ctx, runMutation } = fakeCtx();
		runMutation.mockRejectedValue(new Error('ledger down'));
		await expect(
			meterLlmCall(ctx, { feature: 'translate' }, async (meter) => {
				meter.record({ outcome: 'failed', latencyMs: 1 });
				throw new Error('provider down');
			})
		).rejects.toThrow('provider down');
	});
});

describe('persistMeteredSpend', () => {
	it('retries a transient write, and acknowledges the batch once stored', async () => {
		const { ctx, runMutation } = fakeCtx();
		const target = { feature: 'agent_draft' };
		const meter = meterFor({}, target);
		requests(meter, 2);
		runMutation.mockRejectedValueOnce(new Error('transient'));
		await persistMeteredSpend(ctx, target, meter);
		expect(meter.pendingWrites()).toHaveLength(0);
		// The re-send carried the same two requests; the ledger's
		// (requestId, attempt) idempotency is what makes it safe.
		expect(
			runMutation.mock.calls.map((call) => (call[1] as { requests: unknown[] }).requests.length)
		).toEqual([2, 2]);
	});

	it('hands a batch the ledger keeps refusing to the scheduler, durably', async () => {
		const { ctx, runMutation, runAfter } = fakeCtx();
		const target = { feature: 'assistant_chat' };
		const meter = meterFor({}, target);
		requests(meter, 2);
		runMutation.mockRejectedValue(new Error('ledger down'));
		await persistMeteredSpend(ctx, target, meter);
		expect(runMutation).toHaveBeenCalledTimes(2);
		expect(ledgerRows(runAfter)).toHaveLength(2);
		expect(meter.pendingWrites()).toHaveLength(0);
	});

	it('keeps a batch no path could store, and the later ones, for the next flush', async () => {
		const { ctx, runMutation, runAfter } = fakeCtx();
		const target = { feature: 'agent_draft' };
		const meter = meterFor({}, target);
		for (let i = 0; i < MAX_METERED_REQUESTS_PER_WRITE + 3; i++) {
			meter.record({ outcome: 'ok', latencyMs: 1, usage: usage(1) });
		}
		runMutation.mockResolvedValueOnce(null).mockRejectedValue(new Error('ledger down'));
		runAfter.mockRejectedValue(new Error('scheduler down'));
		await expect(persistMeteredSpend(ctx, target, meter)).rejects.toThrow('scheduler down');
		// The first batch is stored; the second stays pending.
		expect(meter.pendingWrites().map((r) => r.attempt)).toEqual([
			MAX_METERED_REQUESTS_PER_WRITE + 1,
			MAX_METERED_REQUESTS_PER_WRITE + 2,
			MAX_METERED_REQUESTS_PER_WRITE + 3,
		]);

		// The ledger is back: the next flush writes exactly the pending batch.
		runMutation.mockReset().mockResolvedValue(null);
		await persistMeteredSpend(ctx, target, meter);
		expect(meter.pendingWrites()).toHaveLength(0);
		expect(ledgerRows(runMutation)).toHaveLength(3);
	});

	it('gives the meter the action’s deadline, bounded by the root’s', () => {
		const ctx = {};
		const anchored = anchorActionDeadline(ctx);
		expect(meterFor(ctx, { feature: 'agent_draft' }).deadlineAt).toBe(anchored);
		const tight = { rootRequestId: 'team:m', deadlineAt: anchored - 1_000 };
		expect(meterFor(ctx, { feature: 'agent_draft', root: tight }).deadlineAt).toBe(
			anchored - 1_000
		);
	});

	it('writes each request once, however often the meter is flushed', async () => {
		const { ctx, runMutation } = fakeCtx();
		const target = { feature: 'agent_draft' };
		const meter = meterFor({}, target);
		requests(meter, 2);
		await persistMeteredSpend(ctx, target, meter);
		await persistMeteredSpend(ctx, target, meter);
		meter.record({ outcome: 'ok', latencyMs: 1, usage: usage(1) });
		await persistMeteredSpend(ctx, target, meter);
		expect(ledgerRows(runMutation).map((row) => row.attempt)).toEqual([1, 2, 3]);
		expect(runMutation).toHaveBeenCalledTimes(2);
	});

	it('stamps the embedding plane from the task, and a shadow call’s own budget class', async () => {
		const { ctx, runMutation } = fakeCtx();
		const target = { feature: 'embedding_knowledge', budgetClass: 'shadow' as const };
		const meter = meterFor({}, target);
		requests(meter, 1);
		await persistMeteredSpend(ctx, target, meter);
		expect(runMutation.mock.calls[0]![1]).toMatchObject({
			task: 'embedding.index',
			plane: 'embedding',
			budgetClass: 'shadow',
		});
	});
});
