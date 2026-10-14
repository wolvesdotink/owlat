/**
 * A hosted embedding counts toward the enforced spend ceiling (#1268), driven
 * through the production embedding seams rather than a hand-written ledger
 * row: `embedRetrievalQuery` (knowledge recall, file search and Team
 * retrieval) and `embedForIndex` (space rebuild and re-embed). The SDK's
 * `embed` and the embedder resolver are mocked; the dispatch, the meter, the
 * admission and ledger mutations and the enforced status are real (a
 * convex-test instance behind an action ctx). A caller that dropped its
 * `meterLlmCall` wrapper would leave the ledger empty and fail here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';

const sdk = vi.hoisted(() => ({ embed: vi.fn() }));

vi.mock('ai', async () => ({
	...(await vi.importActual<object>('ai')),
	embed: (args: unknown) => sdk.embed(args),
}));

import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import { newHarness } from '../../__tests__/testModules';
import { actionCtxOver, reconcileSpend } from '../../aiRouting/__tests__/spend.testlib';
import { embedRetrievalQuery } from '../../knowledge/vectorSearch';
import { embedForIndex } from '../../lib/aiRouting/embedderForSpace';
import { storedEmbeddingTarget } from '../../lib/embeddingSpace';
import { stampModelEndpoint } from '../../lib/llm/modelEndpoint';
import type { IndexEmbedder } from '../../lib/llmProvider';

const embedder = {
	model: stampModelEndpoint(
		{ modelId: 'text-embedding-3-small', specificationVersion: 'v2' } as never,
		'embedding:openai'
	),
	// A hosted target: no revision probe.
	target: storedEmbeddingTarget({ embeddingProviderKind: 'openai' }),
} as IndexEmbedder;

vi.mock('../../lib/llmProvider', async () => ({
	...(await vi.importActual<object>('../../lib/llmProvider')),
	resolveIndexEmbedder: async () => embedder,
}));

// 600M input tokens of text-embedding-3-small at $0.02 per million: $12.
const TOKENS = 600_000_000;

beforeEach(() => {
	sdk.embed.mockReset();
	sdk.embed.mockResolvedValue({ embedding: [0.1, 0.2, 0.3], usage: { tokens: TOKENS } });
});
afterEach(() => {
	vi.unstubAllEnvs();
});

async function setup() {
	vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '10');
	const t = newHarness();
	await reconcileSpend(t);
	return { t, ...actionCtxOver(t) };
}

async function expectCountedAgainstCeiling(
	t: Awaited<ReturnType<typeof setup>>['t'],
	feature: string
) {
	expect(sdk.embed).toHaveBeenCalledTimes(1);
	const rows = await t.run((c) => c.db.query('llmUsageEvents').collect());
	expect(rows).toEqual([
		expect.objectContaining({
			feature,
			plane: 'embedding',
			modelUsed: 'text-embedding-3-small',
			promptTokens: TOKENS,
			completionTokens: 0,
			costMicrousd: 12_000_000,
			isEstimated: false,
		}),
	]);
	const status = await t.query(internal.aiRouting.enforcedBudget.getBudgetStatus, {});
	expect(status.daily.spentUsd).toBeCloseTo(12);
	expect(status.autonomousAutoSendAllowed).toBe(false);
	expect(status.advisoryAllowed).toBe(false);
}

describe('a hosted embedding counts toward the enforced ceiling (#1268)', () => {
	it('through the retrieval query embedding', async () => {
		const { t, ctx } = await setup();
		// The corpus holds a vector, so the query is embedded; the rest is real.
		const hasVectors = getFunctionName(internal.knowledge.vectorCorpus.hasQueryableVectors);
		const retrievalCtx = {
			...ctx,
			runQuery: (ref: never, args: never) =>
				getFunctionName(ref) === hasVectors ? Promise.resolve(true) : ctx.runQuery(ref, args),
		} as unknown as ActionCtx;

		await embedRetrievalQuery(retrievalCtx, ['knowledgeEntries'], 'order 123', '[test]');

		await expectCountedAgainstCeiling(t, 'embedding_knowledge_search');
	});

	it('through the index embedding (rebuild and re-embed)', async () => {
		const { t, ctx } = await setup();

		await embedForIndex(ctx, embedder, 'An extracted fact.', {
			feature: 'embedding_knowledge',
			task: 'embedding.index',
			root: { rootRequestId: 'reembed:job-1' },
		});

		await expectCountedAgainstCeiling(t, 'embedding_knowledge');
	});
});
