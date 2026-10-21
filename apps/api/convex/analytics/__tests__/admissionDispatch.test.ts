/**
 * Admission at the dispatch, end to end: a metered call
 * reserves before its first provider request, its rows carry the hold, and
 * the meter's writer settles the hold in the same mutation as the rows. The
 * SDK is mocked; the meter, the dispatch, the admission and ledger mutations
 * are real (a convex-test instance behind an action ctx).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ generateText: vi.fn(), embed: vi.fn() }));

vi.mock('ai', async () => ({
	...(await vi.importActual<object>('ai')),
	generateText: (args: unknown) => sdk.generateText(args),
	embed: (args: unknown) => sdk.embed(args),
}));

import { AI_BUDGET_ERROR_CODE } from '@owlat/shared/aiRouting';
import { internal } from '../../_generated/api';
import { newHarness } from '../../__tests__/testModules';
import { runLlmText } from '../../lib/llm/dispatch';
import { runEmbedding } from '../../lib/llm/embed';
import { stampModelEndpoint } from '../../lib/llm/modelEndpoint';
import { AdmissionRefusedError, admissionRefusalOf } from '../../lib/llm/admissionPort';
import { meterFor, meterLlmCall, persistMeteredSpend } from '../meteredSpend';
import { admitEmbeddingBatch } from '../embeddingBatchAdmission';
import { runAdmittedEmbedding } from '../../lib/aiRouting/embeddingDispatch';
import {
	admitPaidEmbeddingBatch,
	isPaidEmbeddingAdmissionAvailable,
} from '../../lib/aiRouting/embeddingAdmission';
import {
	actionCtxOver,
	aggregateTotals,
	reconcileSpend,
} from '../../aiRouting/__tests__/spend.testlib';
import { SETTLEMENT_FEATURE } from '../../aiRouting/settlement';
import { insertLlmUsage } from '../ledgerInsert';

const model = stampModelEndpoint(
	{ modelId: 'gpt-4o', specificationVersion: 'v2' } as never,
	'openai-native'
);
const localModel = stampModelEndpoint(
	{ modelId: 'qwen3:8b', specificationVersion: 'v2' } as never,
	'openai-compatible',
	{ isLocal: true }
);
const usage = (input: number, output: number) => ({
	inputTokens: input,
	outputTokens: output,
	totalTokens: input + output,
});

beforeEach(() => {
	sdk.generateText.mockReset();
	sdk.embed.mockReset();
});
afterEach(() => {
	vi.unstubAllEnvs();
});

async function setup(dailyUsd?: string) {
	if (dailyUsd !== undefined) vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', dailyUsd);
	const t = newHarness();
	if (dailyUsd !== undefined) await reconcileSpend(t);
	return { t, ...actionCtxOver(t) };
}

const askTarget = { feature: 'postbox_ask_thread' } as const;

describe('admission at the dispatch', () => {
	it('reserves before the request, tags the rows, and settles at the reported usage', async () => {
		const { t, ctx } = await setup('10');
		sdk.generateText.mockImplementationOnce(async () => {
			// While the call runs its hold is outstanding.
			const held = await t.run((c) => c.db.query('llmReservations').collect());
			expect(held).toEqual([expect.objectContaining({ status: 'held', task: 'mail.ask' })]);
			return { text: 'ok', usage: usage(100_000, 10_000), finishReason: 'stop' };
		});

		await meterLlmCall(ctx, askTarget, (meter) => runLlmText({ model, prompt: 'hi', meter }));

		const [hold] = await t.run((c) => c.db.query('llmReservations').collect());
		expect(hold).toMatchObject({ status: 'settled', settledMicrousd: 350_000, plane: 'language' });
		const rows = await t.run((c) => c.db.query('llmUsageEvents').collect());
		expect(rows).toEqual([expect.objectContaining({ reservationId: hold!.reservationId })]);
		expect((await aggregateTotals(t)).day).toBe(350_000);
	});

	it('makes no provider request when admission refuses, with the stable budget code', async () => {
		const { t, ctx } = await setup('0.0001');
		const error = await meterLlmCall(ctx, askTarget, (meter) =>
			runLlmText({ model, prompt: 'hi', meter })
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(AdmissionRefusedError);
		expect(admissionRefusalOf(error)).toMatchObject({
			code: AI_BUDGET_ERROR_CODE,
			reason: 'daily_ceiling',
		});
		expect(sdk.generateText).not.toHaveBeenCalled();
		expect(await t.run((c) => c.db.query('llmReservations').collect())).toHaveLength(0);
	});

	it('holds a call at the priority its target names: brief-mode interpretation is background work', async () => {
		const { t, ctx } = await setup('10');
		// $7.10 settled: past background work's line ($10 less the $2 advisory
		// reserve and the unused $1 triage allowance), inside the pipeline's.
		await t.run((c) =>
			insertLlmUsage(
				c,
				'agent_draft',
				{ promptTokens: 2_840_000, completionTokens: 0, totalTokens: 2_840_000 },
				'gpt-4o'
			)
		);
		sdk.generateText.mockResolvedValue({ text: 'ok', usage: usage(10, 5), finishReason: 'stop' });

		const brief = await meterLlmCall(
			ctx,
			{ feature: 'interpret', priority: 'background' },
			(meter) => runLlmText({ model, prompt: 'hi', meter })
		).catch((e: unknown) => e);
		expect(admissionRefusalOf(brief)).toMatchObject({ reason: 'daily_ceiling' });
		expect((brief as AdmissionRefusedError).limit).toBe('advisory_reserve');

		// The same task without the override runs at its catalog priority (pipeline).
		await meterLlmCall(ctx, { feature: 'interpret' }, (meter) =>
			runLlmText({ model, prompt: 'hi', meter })
		);
		expect(sdk.generateText).toHaveBeenCalledTimes(1);
	});

	it('refuses while the spend state cannot be verified (#1333)', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '10');
		const t = newHarness();
		const { ctx } = actionCtxOver(t);
		const error = await meterLlmCall(ctx, askTarget, (meter) =>
			runLlmText({ model, prompt: 'hi', meter })
		).catch((e: unknown) => e);
		expect(admissionRefusalOf(error)?.reason).toBe('spend_unverifiable');
		expect(sdk.generateText).not.toHaveBeenCalled();
	});

	it('reserves nothing with no ceiling configured: today’s behaviour', async () => {
		const { t, ctx } = await setup();
		const runMutation = vi.spyOn(ctx, 'runMutation');
		sdk.generateText.mockResolvedValueOnce({
			text: 'ok',
			usage: usage(10, 5),
			finishReason: 'stop',
		});

		await meterLlmCall(ctx, askTarget, (meter) => runLlmText({ model, prompt: 'hi', meter }));

		const names = runMutation.mock.calls.map(([ref]) => JSON.stringify(ref));
		expect(names.some((name) => name.includes('reserve'))).toBe(false);
		expect(await t.run((c) => c.db.query('llmReservations').collect())).toHaveLength(0);
		expect(await t.run((c) => c.db.query('llmUsageEvents').collect())).toHaveLength(1);
	});

	it('does not hold a local model', async () => {
		const { t, ctx } = await setup('10');
		sdk.generateText.mockResolvedValueOnce({
			text: 'ok',
			usage: usage(10, 5),
			finishReason: 'stop',
		});
		await meterLlmCall(ctx, askTarget, (meter) =>
			runLlmText({ model: localModel, prompt: 'hi', meter })
		);
		expect(await t.run((c) => c.db.query('llmReservations').collect())).toHaveLength(0);
	});

	it('settles a cancelled call conservatively: the aborted request is charged its share', async () => {
		const { t, ctx } = await setup('10');
		sdk.generateText.mockRejectedValueOnce(
			Object.assign(new Error('aborted'), { name: 'AbortError' })
		);

		await expect(
			meterLlmCall(ctx, askTarget, (meter) =>
				runLlmText({ model, prompt: 'hi', meter, maxAttempts: 1 })
			)
		).rejects.toThrow('aborted');

		const [hold] = await t.run((c) => c.db.query('llmReservations').collect());
		expect(hold).toMatchObject({ status: 'settled' });
		expect(hold!.settledMicrousd).toBe(hold!.heldMicrousd);
		const rows = await t.run((c) => c.db.query('llmUsageEvents').collect());
		expect(rows.map((row) => row.feature).sort()).toEqual(
			['postbox_ask_thread', SETTLEMENT_FEATURE].sort()
		);
	});

	it('leaves the hold for the sweep when the action dies between dispatch and settlement', async () => {
		const { t, ctx } = await setup('10');
		sdk.generateText.mockResolvedValueOnce({
			text: 'ok',
			usage: usage(100_000, 10_000),
			finishReason: 'stop',
		});
		const meter = meterFor(ctx, askTarget);
		await runLlmText({ model, prompt: 'hi', meter });
		// The action dies here: the meter's rows are never written.
		const [hold] = await t.run((c) => c.db.query('llmReservations').collect());
		expect(hold).toMatchObject({ status: 'held' });

		await t.run(async (c) => c.db.patch(hold!._id, { expiresAt: Date.now() - 1 }));
		await t.mutation(internal.aiRouting.admission.sweepExpiredHolds, {});

		const [expired] = await t.run((c) => c.db.query('llmReservations').collect());
		expect(expired).toMatchObject({ status: 'expired', settledMicrousd: hold!.heldMicrousd });
		expect((await aggregateTotals(t)).day).toBe(hold!.heldMicrousd);
	});

	it('gives each dispatch on one meter its own hold, settled by one flush', async () => {
		const { t, ctx } = await setup('10');
		sdk.generateText
			.mockResolvedValueOnce({ text: 'a', usage: usage(1_000, 100), finishReason: 'stop' })
			.mockResolvedValueOnce({ text: 'b', usage: usage(2_000, 100), finishReason: 'stop' });
		const meter = meterFor(ctx, askTarget);
		await runLlmText({ model, prompt: 'one', meter });
		await runLlmText({ model, prompt: 'two', meter });
		await persistMeteredSpend(ctx, askTarget, meter);

		const rows = await t.run((c) => c.db.query('llmReservations').collect());
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.status === 'settled')).toBe(true);
		const ledger = await t.run((c) => c.db.query('llmUsageEvents').collect());
		expect(new Set(ledger.map((row) => row.reservationId)).size).toBe(2);
	});

	it('adds no hold under a caller’s own reservation (an outer hold)', async () => {
		const { t, ctx } = await setup('10');
		sdk.embed.mockResolvedValue({ embedding: [0.1, 0.2], usage: { tokens: 12 } });
		const embedder = stampModelEndpoint(
			{ modelId: 'text-embedding-3-small', specificationVersion: 'v2' } as never,
			'embedding:openai'
		);
		const batch = await admitEmbeddingBatch(ctx, {
			rootRequestId: 'reembed:job-1',
			task: 'embedding.index',
			jobKind: 'reembed',
			provider: 'openai',
			model: 'text-embedding-3-small',
			items: 2,
			inputChars: 4_000,
		});
		if (!batch.isAdmitted) throw new Error('refused');
		const target = {
			feature: 'embedding_knowledge',
			root: { rootRequestId: 'reembed:job-1' },
			...(batch.reservationId ? { reservationId: batch.reservationId } : {}),
		};
		for (const value of ['one', 'two']) {
			await meterLlmCall(ctx, target, (meter) => runEmbedding({ model: embedder, value, meter }));
		}
		await batch.settle({ dispatchedCalls: 2, providerRequests: 2, inputTokens: undefined });

		const holds = await t.run((c) => c.db.query('llmReservations').collect());
		expect(holds).toEqual([
			expect.objectContaining({ status: 'settled', plane: 'embedding', task: 'embedding.index' }),
		]);
		const ledger = await t.run((c) => c.db.query('llmUsageEvents').collect());
		expect(ledger.every((row) => row.reservationId === batch.reservationId)).toBe(true);
	});

	it('settles a batch once every provider request is in, retries included (Sol r2 F5)', async () => {
		const { t, ctx } = await setup('10');
		// One call retried once, then a second call: three provider requests.
		sdk.embed
			.mockRejectedValueOnce(Object.assign(new Error('overloaded'), { statusCode: 529 }))
			.mockResolvedValue({ embedding: [0.1, 0.2], usage: { tokens: 12 } });
		const embedder = {
			model: stampModelEndpoint(
				{ modelId: 'text-embedding-3-small', specificationVersion: 'v2' } as never,
				'embedding:openai'
			),
			target: { isLocal: false, provider: 'openai', model: 'text-embedding-3-small' },
		} as never;
		const outcome = await runAdmittedEmbedding(
			ctx,
			embedder,
			{
				rootRequestId: 'reembed:job-4',
				task: 'embedding.index',
				jobKind: 'reembed',
				items: 2,
				inputChars: 6,
			},
			async (counter) => {
				const target = {
					feature: 'embedding_knowledge' as const,
					root: { rootRequestId: 'reembed:job-4' },
					...(counter.reservationId ? { reservationId: counter.reservationId } : {}),
				};
				for (const value of ['one', 'two']) {
					counter.dispatched += 1;
					await meterLlmCall(ctx, target, async (meter) => {
						try {
							return await runEmbedding({
								model: (embedder as { model: never }).model,
								value,
								meter,
							});
						} finally {
							counter.providerRequests += meter.requests.length;
						}
					});
				}
				return counter.providerRequests;
			}
		);
		expect(outcome).toEqual({ isAdmitted: true, value: 3 });
		const [hold] = await t.run((c) => c.db.query('llmReservations').collect());
		expect(hold).toMatchObject({ status: 'settled' });
		const rows = await t.run((c) => c.db.query('llmUsageEvents').collect());
		expect(rows.filter((row) => row.feature === 'embedding_knowledge')).toHaveLength(3);
	});

	it('keeps a batch held while one of its provider requests is still on its way', async () => {
		const { t, ctx } = await setup('10');
		const batch = await admitEmbeddingBatch(ctx, {
			rootRequestId: 'reembed:job-5',
			task: 'embedding.index',
			jobKind: 'reembed',
			provider: 'openai',
			model: 'text-embedding-3-small',
			items: 2,
			inputChars: 6,
		});
		if (!batch.isAdmitted) throw new Error('refused');
		// Two calls, three requests (one retried), only two rows written so far.
		await t.mutation(internal.analytics.llmUsage.recordRequests, {
			feature: 'embedding_knowledge',
			requestId: 'call-a',
			reservationId: batch.reservationId!,
			requests: [
				{ attempt: 1, latencyMs: 1, modelUsed: 'text-embedding-3-small' },
				{
					attempt: 2,
					latencyMs: 1,
					modelUsed: 'text-embedding-3-small',
					usage: { promptTokens: 4, completionTokens: 0, totalTokens: 4 },
				},
			],
		});
		await batch.settle({ dispatchedCalls: 2, providerRequests: 3, inputTokens: undefined });
		expect((await t.run((c) => c.db.query('llmReservations').collect()))[0]).toMatchObject({
			status: 'held',
		});
	});

	it('fills the embed lane’s seam: paid batches go through spend admission', async () => {
		expect(isPaidEmbeddingAdmissionAvailable()).toBe(true);
		const { t, ctx } = await setup('10');
		const batch = await admitPaidEmbeddingBatch(ctx, {
			rootRequestId: 'reembed:job-3',
			task: 'embedding.index',
			jobKind: 'reembed',
			provider: 'openai',
			model: 'text-embedding-3-small',
			items: 1,
			inputChars: 100,
		});
		if (!batch.isAdmitted) throw new Error('refused');
		await batch.settle({ dispatchedCalls: 0, providerRequests: 0, inputTokens: undefined });
		const holds = await t.run((c) => c.db.query('llmReservations').collect());
		expect(holds).toEqual([expect.objectContaining({ status: 'released', plane: 'embedding' })]);
	});

	it('refuses a paid embedding batch over the embedding plane’s share', async () => {
		const { ctx } = await setup('0.001');
		const batch = await admitEmbeddingBatch(ctx, {
			rootRequestId: 'reembed:job-2',
			task: 'embedding.index',
			jobKind: 'reembed',
			provider: 'openai',
			model: 'text-embedding-3-large',
			items: 500,
			inputChars: 4_000_000,
		});
		expect(batch).toMatchObject({ isAdmitted: false });
	});
});
