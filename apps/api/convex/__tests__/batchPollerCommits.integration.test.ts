/**
 * What one run of `aiRouting/batchPoller.poll` writes for each due item,
 * apart from the result paths `batchApi.integration.test.ts` covers: an item
 * whose poll fails, or whose provider the language plane no longer is, is
 * asked again later and nothing else changes; a failing item never stops the
 * rest of its page; a full page continues with the next one. The provider is
 * a stubbed fetch; the item mutations are real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { newHarness } from './testModules';
import { __resetAiConfigCacheForTests } from '../lib/llmProvider';
import { BATCH_POLL_INTERVAL_MS, batchItemKey } from '../lib/aiRouting/batchConsumers';

type Harness = ReturnType<typeof newHarness>;

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	});

/** The OpenAI batch endpoint: `batch_ok` is still running, every other batch read fails. */
function stubOpenAi() {
	const fetchFn = vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith('/v1/batches/batch_ok'))
			return json({ id: 'batch_ok', status: 'in_progress' });
		return json({ error: { message: 'unavailable' } }, 503);
	});
	vi.stubGlobal('fetch', fetchFn);
	return fetchFn;
}

async function insertItem(
	t: Harness,
	key: string,
	fields: Partial<Doc<'llmBatchItems'>> = {}
): Promise<Id<'llmBatchItems'>> {
	return t.run(async (ctx) => {
		const now = Date.now();
		return ctx.db.insert('llmBatchItems', {
			itemKey: batchItemKey('knowledge_message', key),
			consumer: 'knowledge_message',
			sourceId: key,
			task: 'knowledge.extract',
			provider: 'openai-native',
			modelId: 'gpt-6-luna',
			requestId: `req-${key}`,
			rootRequestId: `team:${key}`,
			policyVersion: 3,
			requestBoundMicrousd: 1_000,
			status: 'submitted',
			providerBatchId: 'batch_ok',
			nextPollAt: now - 1,
			expiresAt: now + 60 * 60_000,
			createdAt: now,
			updatedAt: now,
			...fields,
		});
	});
}

const item = (t: Harness, id: Id<'llmBatchItems'>) => t.run(async (ctx) => (await ctx.db.get(id))!);
const rows = (t: Harness) => t.run((ctx) => ctx.db.query('llmUsageEvents').collect());
const pollRuns = (t: Harness) =>
	t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.name.includes('batchPoller') && job.state.kind === 'pending')
			.map((job) => job.args[0])
	);

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv('LLM_API_KEY', 'sk-test');
	__resetAiConfigCacheForTests();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('batch poller, per item', () => {
	it('asks a running batch again later and writes nothing else', async () => {
		const t = newHarness();
		stubOpenAi();
		const id = await insertItem(t, 'running');

		await t.action(internal.aiRouting.batchPoller.poll, {});

		const after = await item(t, id);
		expect(after.status).toBe('submitted');
		expect(after.nextPollAt).toBe(Date.now() + BATCH_POLL_INTERVAL_MS);
		expect(await rows(t)).toEqual([]);
	});

	it('asks again later when the poll itself fails', async () => {
		const t = newHarness();
		stubOpenAi();
		const id = await insertItem(t, 'broken', { providerBatchId: 'batch_broken' });

		await t.action(internal.aiRouting.batchPoller.poll, {});

		const after = await item(t, id);
		expect(after.status).toBe('submitted');
		expect(after.nextPollAt).toBe(Date.now() + BATCH_POLL_INTERVAL_MS);
		expect(await rows(t)).toEqual([]);
	});

	it('asks again later when the language plane moved off the item’s provider', async () => {
		const t = newHarness();
		const fetchFn = stubOpenAi();
		const id = await insertItem(t, 'moved', { provider: 'anthropic-native' });

		await t.action(internal.aiRouting.batchPoller.poll, {});

		const after = await item(t, id);
		expect(after.status).toBe('submitted');
		expect(after.nextPollAt).toBe(Date.now() + BATCH_POLL_INTERVAL_MS);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('abandons a submission never confirmed, charging its bound once', async () => {
		const t = newHarness();
		stubOpenAi();
		const id = await insertItem(t, 'unconfirmed', { status: 'submitting' });

		await t.action(internal.aiRouting.batchPoller.poll, {});

		expect(await item(t, id)).toMatchObject({ status: 'abandoned', outcome: 'lost' });
		expect(await rows(t)).toEqual([
			expect.objectContaining({
				requestId: 'req-unconfirmed',
				costMicrousd: 1_000,
				isEstimated: true,
			}),
		]);
	});

	it('settles the rest of the page when one item fails', async () => {
		const t = newHarness();
		stubOpenAi();
		const broken = await insertItem(t, 'broken', { providerBatchId: 'batch_broken' });
		const expired = await insertItem(t, 'expired', { expiresAt: Date.now() - 1 });

		await t.action(internal.aiRouting.batchPoller.poll, {});

		expect((await item(t, broken)).status).toBe('submitted');
		expect(await item(t, expired)).toMatchObject({ status: 'abandoned', outcome: 'lost' });
		expect((await rows(t)).map((row) => row.requestId)).toEqual(['req-expired']);
	});

	it('continues with the next page after a full one, and stops after a short one', async () => {
		const t = newHarness();
		stubOpenAi();
		for (let i = 0; i < 25; i++) await insertItem(t, `expired-${i}`, { expiresAt: Date.now() - 1 });

		await t.action(internal.aiRouting.batchPoller.poll, {});

		expect(await pollRuns(t)).toEqual([{ page: 2 }]);
		expect(await rows(t)).toHaveLength(25);

		const short = newHarness();
		stubOpenAi();
		await insertItem(short, 'expired', { expiresAt: Date.now() - 1 });
		await short.action(internal.aiRouting.batchPoller.poll, {});
		expect(await pollRuns(short)).toEqual([]);
	});
});
