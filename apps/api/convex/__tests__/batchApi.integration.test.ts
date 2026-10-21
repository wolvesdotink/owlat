/**
 * Provider batch APIs for non-interactive work,
 * end to end over a stubbed OpenAI: the consumer's call, the item and its
 * hold, the poller, the ledger row and the continuation. The admission,
 * ledger and item mutations are real; nothing reaches a provider.
 *
 *   - Off (the default) is today: no item, no hold, no request but the
 *     real-time one.
 *   - On: every batch item is held before it is sent, its one request is
 *     written to the ledger at the batch rate, and its hold settles exactly
 *     once, however often the poller or the completion runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { newHarness } from './testModules';
import { createTestInboundMessage, createTestSemanticFile, enableFeatures } from './factories';
import { actionCtxOver, reconcileSpend } from '../aiRouting/__tests__/spend.testlib';
import { languageProviderFor } from '../lib/llmProviders';
import { stampModelEndpoint } from '../lib/llm/modelEndpoint';
import { __resetAiConfigCacheForTests } from '../lib/llmProvider';
import { sendThroughBatch } from '../lib/llm/batch/submit';
import { admissionRefusalOf } from '../lib/llm/admissionPort';
import { estimateCost } from '../lib/llm/pricing';
import { usdToMicrousd } from '../lib/aiRouting/spendPeriods';
import { batchItemKey } from '../lib/aiRouting/batchConsumers';

type Harness = ReturnType<typeof newHarness>;

const ENTRIES = [
	{ type: 'fact', title: 'Renewal', content: 'Acme renews in May.', confidence: 0.9 },
	{ type: 'decision', title: 'Plan', content: 'They chose the annual plan.', confidence: 0.7 },
];
const USAGE = { input_tokens: 1_200, output_tokens: 300 };

/** The Responses API body the batch's output line carries for the request. */
function responsesBody(entries: unknown[] = ENTRIES) {
	return {
		id: 'resp_1',
		object: 'response',
		created_at: 1_760_000_000,
		status: 'completed',
		model: 'gpt-6-luna',
		output: [
			{
				type: 'message',
				id: 'msg_1',
				status: 'completed',
				role: 'assistant',
				content: [{ type: 'output_text', text: JSON.stringify({ entries }), annotations: [] }],
			},
		],
		incomplete_details: null,
		usage: {
			...USAGE,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: USAGE.input_tokens + USAGE.output_tokens,
		},
	};
}

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	});

/** A stub of the OpenAI Files and Batches endpoints, holding one batch. */
function fakeOpenAi() {
	const state = {
		status: 'in_progress',
		/** The output file's text once the batch ended (absent: no output file). */
		output: '' as string | undefined,
		/** The error file's text (absent: no error file). */
		errors: undefined as string | undefined,
		uploads: [] as string[],
		createStatus: 200,
		calls: [] as { method: string; url: string }[],
	};
	const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		state.calls.push({ method, url });
		if (method === 'POST' && url.endsWith('/v1/files')) {
			const file = (init!.body as FormData).get('file') as Blob;
			state.uploads.push(await file.text());
			return json({ id: 'file-in' });
		}
		if (method === 'POST' && url.endsWith('/v1/batches')) {
			return state.createStatus === 200
				? json({ id: 'batch_1', status: 'validating' })
				: json({ error: {} }, state.createStatus);
		}
		if (method === 'GET' && url.endsWith('/v1/batches/batch_1')) {
			return json({
				id: 'batch_1',
				status: state.status,
				...(state.status !== 'in_progress' && state.output !== undefined
					? { output_file_id: 'file-out' }
					: {}),
				...(state.status !== 'in_progress' && state.errors !== undefined
					? { error_file_id: 'file-err' }
					: {}),
			});
		}
		if (method === 'GET' && url.endsWith('/v1/files/file-out/content')) {
			return new Response(state.output ?? '');
		}
		if (method === 'GET' && url.endsWith('/v1/files/file-err/content')) {
			return new Response(state.errors ?? '');
		}
		if (method === 'DELETE') return json({ deleted: true });
		throw new Error(`unexpected request ${method} ${url}`);
	});
	return { state, fetchFn };
}

const openAiModel = () =>
	stampModelEndpoint(
		languageProviderFor('openai').buildChatModel({ apiKey: 'sk-test' }, 'gpt-6-luna'),
		'openai-native'
	);

async function setPolicy(t: Harness, batchApi: 'off' | 'enforce') {
	await t.run(async (ctx) => {
		await ctx.db.insert('aiRoutingPolicy', {
			batchApi,
			policyVersion: 3,
			updatedAt: Date.now(),
			updatedBy: 'admin',
		});
	});
}

async function setup(opts: { dailyUsd?: string; batchApi?: 'off' | 'enforce' } = {}) {
	vi.stubEnv('LLM_API_KEY', 'sk-test');
	if (opts.dailyUsd !== undefined) vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', opts.dailyUsd);
	const t = newHarness();
	if (opts.dailyUsd !== undefined) await reconcileSpend(t);
	if (opts.batchApi) await setPolicy(t, opts.batchApi);
	// The result is kept only while knowledge is on (Sol r2 F1).
	await enableFeatures(t, ['ai.knowledge']);
	const openai = fakeOpenAi();
	vi.stubGlobal('fetch', openai.fetchFn);
	return { t, openai, ...actionCtxOver(t) };
}

async function seedMessage(t: Harness): Promise<Id<'inboundMessages'>> {
	const { threadId: _thread, contactId: _contact, ...message } = createTestInboundMessage();
	return t.run((ctx) => ctx.db.insert('inboundMessages', message as never));
}

const candidate = (sourceId: string) => ({
	consumer: 'knowledge_message' as const,
	sourceId,
	model: openAiModel(),
	prompt: 'Extract organizational knowledge from this email message.\n\nBody:\nAcme renews in May.',
	root: { rootRequestId: `team:${sourceId}` },
});

const items = (t: Harness) => t.run((c) => c.db.query('llmBatchItems').collect());
const holds = (t: Harness) => t.run((c) => c.db.query('llmReservations').collect());
const rows = (t: Harness) => t.run((c) => c.db.query('llmUsageEvents').collect());
const scheduled = (t: Harness) => t.run((c) => c.db.system.query('_scheduled_functions').collect());

/** Complete the stub's batch with `body` for the item's request, and make the item due. */
async function completeBatch(
	t: Harness,
	openai: ReturnType<typeof fakeOpenAi>,
	item: Doc<'llmBatchItems'>,
	body: unknown = responsesBody()
) {
	openai.state.status = 'completed';
	openai.state.output = `${JSON.stringify({
		id: 'batch_req_1',
		custom_id: item.requestId,
		response: { status_code: 200, request_id: 'r1', body },
		error: null,
	})}\n`;
	await t.run((c) => c.db.patch(item._id, { nextPollAt: Date.now() - 1 }));
}

beforeEach(() => {
	__resetAiConfigCacheForTests();
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('batch API off (the default)', () => {
	it('sends nothing and records nothing: the caller makes today’s real-time call', async () => {
		const { t, ctx, openai } = await setup({ dailyUsd: '10' });
		const messageId = await seedMessage(t);

		expect(await sendThroughBatch(ctx, candidate(messageId))).toBe(false);

		expect(openai.fetchFn).not.toHaveBeenCalled();
		expect(await items(t)).toHaveLength(0);
		expect(await holds(t)).toHaveLength(0);
	});

	it('stays off for an explicit off, and for an adapter without a batch API', async () => {
		const off = await setup({ batchApi: 'off' });
		expect(await sendThroughBatch(off.ctx, candidate(await seedMessage(off.t)))).toBe(false);

		const on = await setup({ batchApi: 'enforce' });
		const compatible = stampModelEndpoint(
			languageProviderFor('openai').buildChatModel({ apiKey: 'sk-test' }, 'gpt-6-luna'),
			'custom'
		);
		expect(
			await sendThroughBatch(on.ctx, {
				...candidate(await seedMessage(on.t)),
				model: compatible,
			})
		).toBe(false);
		expect(on.openai.fetchFn).not.toHaveBeenCalled();
		expect(await items(on.t)).toHaveLength(0);
	});
});

describe('batch API on', () => {
	it('holds the request before it is sent, and sends the real-time body', async () => {
		const { t, ctx, openai } = await setup({ dailyUsd: '10', batchApi: 'enforce' });
		const messageId = await seedMessage(t);

		expect(await sendThroughBatch(ctx, candidate(messageId))).toBe(true);

		const [item] = await items(t);
		expect(item).toMatchObject({
			status: 'submitted',
			itemKey: batchItemKey('knowledge_message', messageId),
			provider: 'openai-native',
			modelId: 'gpt-6-luna',
			providerBatchId: 'batch_1',
			providerFileId: 'file-in',
			policyVersion: 3,
			rootRequestId: `team:${messageId}`,
		});
		const [hold] = await holds(t);
		expect(hold).toMatchObject({
			status: 'held',
			reservationId: item!.reservationId,
			task: 'knowledge.extract',
			priority: 'background',
			maxAttempts: 1,
		});
		expect(hold!.heldMicrousd).toBeGreaterThan(0);
		// The upload carries one line: the request under its custom id.
		const line = JSON.parse(openai.state.uploads[0]!) as { custom_id: string; url: string };
		expect(line).toMatchObject({ custom_id: item!.requestId, url: '/v1/responses' });
		// No real-time request was made.
		expect(openai.state.calls.some((call) => call.url.endsWith('/v1/responses'))).toBe(false);
	});

	it('keeps a source its resume would refuse real-time: nothing is held or sent', async () => {
		const { t, ctx, openai } = await setup({ dailyUsd: '10', batchApi: 'enforce' });
		const isEligible = vi.fn(async () => false);

		expect(await sendThroughBatch(ctx, { ...candidate(await seedMessage(t)), isEligible })).toBe(
			false
		);

		expect(isEligible).toHaveBeenCalledTimes(1);
		expect(openai.state.calls.some((call) => call.method === 'POST')).toBe(false);
		expect(await items(t)).toHaveLength(0);
		expect(await holds(t)).toHaveLength(0);
	});

	it('sends a source once: a second run while its item is out sends and holds nothing', async () => {
		const { t, ctx, openai } = await setup({ dailyUsd: '10', batchApi: 'enforce' });
		const messageId = await seedMessage(t);
		await sendThroughBatch(ctx, candidate(messageId));
		const sent = openai.fetchFn.mock.calls.length;

		expect(await sendThroughBatch(ctx, candidate(messageId))).toBe(true);

		expect(openai.fetchFn.mock.calls.length).toBe(sent);
		expect(await items(t)).toHaveLength(1);
		expect(await holds(t)).toHaveLength(1);
	});

	it('settles the hold exactly once, at the batch rate, and resumes the extraction', async () => {
		const { t, ctx, openai } = await setup({ dailyUsd: '10', batchApi: 'enforce' });
		const messageId = await seedMessage(t);
		await sendThroughBatch(ctx, candidate(messageId));
		const [item] = await items(t);

		// Still running: postponed, nothing written.
		await t.run((c) => c.db.patch(item!._id, { nextPollAt: Date.now() - 1 }));
		await t.action(internal.aiRouting.batchPoller.poll, {});
		expect((await items(t))[0]!.nextPollAt).toBeGreaterThan(Date.now());
		expect(await rows(t)).toHaveLength(0);

		await completeBatch(t, openai, item!);
		await t.action(internal.aiRouting.batchPoller.poll, {});
		// Polling again, and a duplicate completion, change nothing.
		await t.run((c) => c.db.patch(item!._id, { nextPollAt: Date.now() - 1 }));
		await t.action(internal.aiRouting.batchPoller.poll, {});
		expect(
			await t.mutation(internal.aiRouting.batchItems.completeItem, {
				itemId: item!._id,
				outcome: 'succeeded',
				entries: ENTRIES as never,
			})
		).toBe(false);

		const [closed] = await items(t);
		expect(closed).toMatchObject({ status: 'completed', outcome: 'succeeded' });
		const ledger = await rows(t);
		expect(ledger).toHaveLength(1);
		const full = usdToMicrousd(
			estimateCost(
				'gpt-6-luna',
				{ promptTokens: 1_200, completionTokens: 300, totalTokens: 1_500 },
				'language'
			).costUsd
		);
		expect(ledger[0]).toMatchObject({
			feature: 'knowledge_extract_message',
			task: 'knowledge.extract',
			requestId: item!.requestId,
			attempt: 1,
			endpoint: 'openai-native+batch',
			reservationId: item!.reservationId,
			rootRequestId: `team:${messageId}`,
			promptTokens: 1_200,
			completionTokens: 300,
		});
		expect(ledger[0]!.costMicrousd).toBeLessThanOrEqual(Math.ceil(full / 2));
		expect(ledger[0]!.costMicrousd).toBeGreaterThan(0);
		const [hold] = await holds(t);
		expect(hold).toMatchObject({ status: 'settled', settledMicrousd: ledger[0]!.costMicrousd });

		// The entries became the extraction's marker, and the extraction runs again.
		const marker = await t.run((c) => c.db.query('knowledgeExtractionProgress').first());
		expect(marker).toMatchObject({
			sourceType: 'agent_extracted',
			sourceId: messageId,
			status: 'in_progress',
			entries: ENTRIES,
		});
		const jobs = await scheduled(t);
		expect(jobs.filter((job) => job.name.includes('extractFromMessage'))).toEqual([
			expect.objectContaining({ args: [{ inboundMessageId: messageId }] }),
		]);
		// The provider's files are cleaned up after the read.
		expect(openai.state.calls.filter((call) => call.method === 'DELETE').length).toBeGreaterThan(0);
	});

	it('refuses before anything is sent when admission refuses, with the budget code', async () => {
		const { t, ctx, openai } = await setup({ dailyUsd: '0.0001', batchApi: 'enforce' });
		const error = await sendThroughBatch(ctx, candidate(await seedMessage(t))).catch(
			(e: unknown) => e
		);
		expect(admissionRefusalOf(error)).toMatchObject({ reason: 'daily_ceiling' });
		expect(openai.state.calls.some((call) => call.method === 'POST')).toBe(false);
		expect(await items(t)).toHaveLength(0);
		expect(await holds(t)).toHaveLength(0);
	});

	it('settles at zero when the provider definitely refused the batch, and goes real-time', async () => {
		const { t, ctx, openai } = await setup({ dailyUsd: '10', batchApi: 'enforce' });
		openai.state.createStatus = 400;

		expect(await sendThroughBatch(ctx, candidate(await seedMessage(t)))).toBe(false);

		expect(await items(t)).toEqual([
			expect.objectContaining({ status: 'failed', outcome: 'errored' }),
		]);
		expect(await holds(t)).toEqual([
			expect.objectContaining({ status: 'settled', settledMicrousd: 0 }),
		]);
		expect(await rows(t)).toEqual([
			expect.objectContaining({ costMicrousd: 0, endpoint: 'openai-native+batch' }),
		]);
	});

	it('charges the full bound once when the batch may exist (an ambiguous submission)', async () => {
		const { t, ctx, openai } = await setup({ dailyUsd: '10', batchApi: 'enforce' });
		openai.state.createStatus = 503;

		expect(await sendThroughBatch(ctx, candidate(await seedMessage(t)))).toBe(false);

		const [item] = await items(t);
		expect(item).toMatchObject({ status: 'abandoned', outcome: 'lost' });
		const [hold] = await holds(t);
		expect(hold).toMatchObject({ status: 'settled', settledMicrousd: item!.requestBoundMicrousd });
		expect(hold!.heldMicrousd).toBe(item!.requestBoundMicrousd);
		const [row, ...more] = await rows(t);
		expect(more).toHaveLength(0);
		expect(row).toMatchObject({ costMicrousd: item!.requestBoundMicrousd, isEstimated: true });
		// The sweep and a second abandonment add nothing.
		await t.run((c) => c.db.patch(hold!._id, { expiresAt: Date.now() - 1 }));
		await t.mutation(internal.aiRouting.admission.sweepExpiredHolds, {});
		expect(await t.mutation(internal.aiRouting.batchItems.abandonItem, { itemId: item!._id })).toBe(
			false
		);
		expect(await rows(t)).toHaveLength(1);
	});

	it('settles an unbilled result (its own expired record) at zero once, and hands the source back', async () => {
		const { t, ctx, openai } = await setup({ dailyUsd: '10', batchApi: 'enforce' });
		const messageId = await seedMessage(t);
		await sendThroughBatch(ctx, candidate(messageId));
		const [item] = await items(t);
		openai.state.status = 'expired';
		openai.state.output = undefined;
		openai.state.errors = `${JSON.stringify({
			custom_id: item!.requestId,
			response: null,
			error: { code: 'batch_expired', message: 'expired' },
		})}\n`;
		await t.run((c) => c.db.patch(item!._id, { nextPollAt: Date.now() - 1 }));

		await t.action(internal.aiRouting.batchPoller.poll, {});
		expect(
			await t.mutation(internal.aiRouting.batchItems.failItem, {
				itemId: item!._id,
				outcome: 'expired',
			})
		).toBe(false);

		expect((await items(t))[0]).toMatchObject({ status: 'failed', outcome: 'expired' });
		expect((await holds(t))[0]).toMatchObject({ status: 'settled', settledMicrousd: 0 });
		expect(await rows(t)).toEqual([expect.objectContaining({ costMicrousd: 0 })]);
		const jobs = await scheduled(t);
		expect(jobs.filter((job) => job.name.includes('extractFromMessage'))).toHaveLength(1);
		// The re-run goes real-time: one batch attempt per source.
		expect(await sendThroughBatch(ctx, candidate(messageId))).toBe(false);
	});

	it('writes no marker for a source deleted while its batch was out', async () => {
		const { t, ctx, openai } = await setup({ dailyUsd: '10', batchApi: 'enforce' });
		const messageId = await seedMessage(t);
		await sendThroughBatch(ctx, candidate(messageId));
		const [item] = await items(t);
		await t.run((c) => c.db.delete(messageId));
		await completeBatch(t, openai, item!);

		await t.action(internal.aiRouting.batchPoller.poll, {});

		// Billed, so written and settled; nothing continues for the gone source.
		expect(await rows(t)).toHaveLength(1);
		expect((await holds(t))[0]?.status).toBe('settled');
		expect(await t.run((c) => c.db.query('knowledgeExtractionProgress').first())).toBeNull();
		const continued = (await scheduled(t)).filter((job) => !job.name.startsWith('aiRouting/'));
		expect(continued).toHaveLength(0);
	});

	it('hands back a billed result that does not parse, keeping its usage', async () => {
		const { t, ctx, openai } = await setup({ dailyUsd: '10', batchApi: 'enforce' });
		const messageId = await seedMessage(t);
		await sendThroughBatch(ctx, candidate(messageId));
		const [item] = await items(t);
		const broken = responsesBody();
		broken.output[0]!.content[0]!.text = '{"nope":1}';
		await completeBatch(t, openai, item!, broken);

		await t.action(internal.aiRouting.batchPoller.poll, {});

		expect((await items(t))[0]).toMatchObject({ status: 'completed', outcome: 'invalid' });
		const ledger = await rows(t);
		expect(ledger).toHaveLength(1);
		expect(ledger[0]!.costMicrousd).toBeGreaterThan(0);
		expect(await t.run((c) => c.db.query('knowledgeExtractionProgress').first())).toBeNull();
		expect((await scheduled(t)).filter((j) => j.name.includes('extractFromMessage'))).toHaveLength(
			1
		);
	});

	it('abandons an item that never got a result by its expiry, charging its bound once', async () => {
		const { t, ctx } = await setup({ dailyUsd: '10', batchApi: 'enforce' });
		await sendThroughBatch(ctx, candidate(await seedMessage(t)));
		const [item] = await items(t);
		await t.run((c) =>
			c.db.patch(item!._id, { nextPollAt: Date.now() - 1, expiresAt: Date.now() - 1 })
		);

		await t.action(internal.aiRouting.batchPoller.poll, {});

		expect((await items(t))[0]).toMatchObject({ status: 'abandoned', outcome: 'lost' });
		expect((await holds(t))[0]).toMatchObject({
			status: 'settled',
			settledMicrousd: item!.requestBoundMicrousd,
		});
		expect(await rows(t)).toHaveLength(1);
	});

	it.each(['expired', 'cancelled'])(
		'charges the full bound for a %s batch without a usable line for the request (Sol r1 F3)',
		async (status) => {
			const { t, ctx, openai } = await setup({ dailyUsd: '10', batchApi: 'enforce' });
			await sendThroughBatch(ctx, candidate(await seedMessage(t)));
			const [item] = await items(t);
			openai.state.status = status;
			openai.state.output = 'not json\n';
			openai.state.errors = undefined;
			await t.run((c) => c.db.patch(item!._id, { nextPollAt: Date.now() - 1 }));

			await t.action(internal.aiRouting.batchPoller.poll, {});

			expect((await items(t))[0]).toMatchObject({ status: 'abandoned', outcome: 'lost' });
			expect(await rows(t)).toEqual([
				expect.objectContaining({ costMicrousd: item!.requestBoundMicrousd, isEstimated: true }),
			]);
			expect((await holds(t))[0]).toMatchObject({
				status: 'settled',
				settledMicrousd: item!.requestBoundMicrousd,
			});
		}
	);

	describe('with no ceiling configured (nothing held) (Sol r1 F2)', () => {
		it('charges an ambiguous submission its bound, once', async () => {
			const { t, ctx, openai } = await setup({ batchApi: 'enforce' });
			openai.state.createStatus = 503;

			expect(await sendThroughBatch(ctx, candidate(await seedMessage(t)))).toBe(false);

			const [item] = await items(t);
			expect(item).toMatchObject({ status: 'abandoned', outcome: 'lost' });
			expect(item?.reservationId).toBeUndefined();
			expect(item!.requestBoundMicrousd).toBeGreaterThan(0);
			expect(await holds(t)).toHaveLength(0);
			expect(await rows(t)).toEqual([
				expect.objectContaining({
					costMicrousd: item!.requestBoundMicrousd,
					isEstimated: true,
					requestId: item!.requestId,
					attempt: 1,
				}),
			]);
		});

		it('charges an item with no result by its expiry its bound, once', async () => {
			const { t, ctx } = await setup({ batchApi: 'enforce' });
			await sendThroughBatch(ctx, candidate(await seedMessage(t)));
			const [item] = await items(t);
			await t.run((c) =>
				c.db.patch(item!._id, { nextPollAt: Date.now() - 1, expiresAt: Date.now() - 1 })
			);

			await t.action(internal.aiRouting.batchPoller.poll, {});
			expect(
				await t.mutation(internal.aiRouting.batchItems.abandonItem, { itemId: item!._id })
			).toBe(false);

			expect((await items(t))[0]).toMatchObject({ status: 'abandoned', outcome: 'lost' });
			expect(await holds(t)).toHaveLength(0);
			expect(await rows(t)).toEqual([
				expect.objectContaining({ costMicrousd: item!.requestBoundMicrousd, isEstimated: true }),
			]);
		});
	});

	it('records the row alone with no ceiling configured: nothing is held, as today', async () => {
		const { t, ctx, openai } = await setup({ batchApi: 'enforce' });
		await sendThroughBatch(ctx, candidate(await seedMessage(t)));
		const [item] = await items(t);
		expect(item?.reservationId).toBeUndefined();
		await completeBatch(t, openai, item!);

		await t.action(internal.aiRouting.batchPoller.poll, {});

		expect(await holds(t)).toHaveLength(0);
		expect(await rows(t)).toEqual([
			expect.objectContaining({ endpoint: 'openai-native+batch', attempt: 1 }),
		]);
	});

	it('continues a file summary by processing the file again with it', async () => {
		const { t } = await setup({ dailyUsd: '10', batchApi: 'enforce' });
		const fileId = await t.run(async (c) => {
			const storageId = await c.storage.store(new Blob(['budget']));
			return c.db.insert('semanticFiles', createTestSemanticFile({ storageId }) as never);
		});
		const itemId = await t.run(async (c) => {
			const now = Date.now();
			return c.db.insert('llmBatchItems', {
				itemKey: batchItemKey('file_summary', fileId),
				consumer: 'file_summary',
				sourceId: fileId,
				task: 'file.summarize',
				provider: 'openai-native',
				modelId: 'gpt-6-luna',
				requestId: 'req-file',
				rootRequestId: `file:${fileId}`,
				policyVersion: 3,
				requestBoundMicrousd: 1_000,
				status: 'submitted',
				providerBatchId: 'batch_1',
				nextPollAt: now,
				expiresAt: now + 60_000,
				createdAt: now,
				updatedAt: now,
			});
		});
		const summary = { title: 'Budget', summary: 'Hosting rose.', tags: ['budget'] };

		await t.mutation(internal.aiRouting.batchItems.completeItem, {
			itemId,
			outcome: 'succeeded',
			summary,
		});

		const jobs = await scheduled(t);
		expect(jobs.filter((job) => job.name.includes('processFile'))).toEqual([
			expect.objectContaining({ args: [{ fileId, batchedSummary: summary }] }),
		]);
	});
});

describe('retention', () => {
	it('deletes terminal batch items past the audit window, never live ones', async () => {
		const t = newHarness();
		const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
		await t.run(async (c) => {
			for (const status of ['completed', 'submitted'] as const) {
				await c.db.insert('llmBatchItems', {
					itemKey: `knowledge_message:${status}`,
					consumer: 'knowledge_message',
					sourceId: status,
					task: 'knowledge.extract',
					provider: 'openai-native',
					modelId: 'gpt-6-luna',
					requestId: status,
					rootRequestId: `team:${status}`,
					policyVersion: 0,
					requestBoundMicrousd: 1_000,
					status,
					nextPollAt: old,
					expiresAt: old,
					createdAt: old,
					updatedAt: old,
				});
			}
		});

		await t.mutation(internal.maintenance.retention.sweepAiRoutingRecords, {});

		expect((await items(t)).map((item) => item.status)).toEqual(['submitted']);
	});
});
