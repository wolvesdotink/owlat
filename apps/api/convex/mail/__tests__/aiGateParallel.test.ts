/**
 * Setup latency on the Postbox AI paths (plan 1.14): the gate mutation and the
 * setup reads run side by side (`gatedInParallel`), the gate's verdict still
 * wins, and interactive spend is scheduled rather than awaited
 * (`scheduleLlmSpend`).
 */

import { describe, it, expect, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import { gatedInParallel } from '../ai/gate';
import { scheduleLlmSpend } from '../../analytics/llmUsage';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function ctxWithGate(gate: Promise<unknown>) {
	const runMutation = vi.fn(() => gate);
	return { ctx: { runMutation } as unknown as ActionCtx, runMutation };
}

describe('gatedInParallel', () => {
	it('starts the work before the gate settles and returns its value', async () => {
		const gate = deferred<null>();
		const { ctx, runMutation } = ctxWithGate(gate.promise);
		const work = deferred<string>();
		const result = gatedInParallel(ctx, work.promise);
		// The work is already running while the gate is still pending.
		work.resolve('thread');
		await Promise.resolve();
		expect(runMutation).toHaveBeenCalledTimes(1);
		gate.resolve(null);
		await expect(result).resolves.toBe('thread');
	});

	it("throws the gate's error even when the work failed too", async () => {
		const { ctx } = ctxWithGate(Promise.reject(new Error('AI features are disabled')));
		const work = Promise.reject(new Error('thread read failed'));
		await expect(gatedInParallel(ctx, work)).rejects.toThrow('AI features are disabled');
	});

	it("throws the work's error once the gate passed", async () => {
		const { ctx } = ctxWithGate(Promise.resolve(null));
		await expect(gatedInParallel(ctx, Promise.reject(new Error('not configured')))).rejects.toThrow(
			'not configured'
		);
	});

	it('does not return before the work settles when the gate rejects', async () => {
		const { ctx } = ctxWithGate(Promise.reject(new Error('rate limited')));
		const work = deferred<string>();
		let settled = false;
		const result = gatedInParallel(ctx, work.promise).catch((error: unknown) => {
			settled = true;
			throw error;
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(settled).toBe(false);
		work.resolve('late');
		await expect(result).rejects.toThrow('rate limited');
	});
});

describe('scheduleLlmSpend', () => {
	it('schedules the ledger write instead of running it inline', async () => {
		const runAfter = vi.fn(async () => undefined);
		const runMutation = vi.fn();
		const ctx = { scheduler: { runAfter }, runMutation } as unknown as ActionCtx;
		const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
		await scheduleLlmSpend(ctx, 'postbox_complete_draft', usage, 'fast-model');
		expect(runMutation).not.toHaveBeenCalled();
		expect(runAfter).toHaveBeenCalledWith(0, expect.anything(), {
			feature: 'postbox_complete_draft',
			modelUsed: 'fast-model',
			tokenUsage: usage,
		});
	});

	it('writes nothing when the provider reported no usage', async () => {
		const runAfter = vi.fn();
		const ctx = { scheduler: { runAfter } } as unknown as ActionCtx;
		await scheduleLlmSpend(ctx, 'postbox_summarize', undefined, undefined);
		expect(runAfter).not.toHaveBeenCalled();
	});
});
