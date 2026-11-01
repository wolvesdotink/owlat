/**
 * A hosted embedding counts toward the enforced spend ceiling, driven
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
import { estimateCost } from '../../lib/llm/pricing';
import { usdToMicrousd } from '../../lib/aiRouting/spendPeriods';
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

const TOKENS = 600_000_000;
// What the ledger prices this call at, from the same lookup it uses; the exact
// rate is the pricing tests' to pin. The ceiling is half of it, so one call is
// over it whatever the listed rate.
const EXPECTED = estimateCost(
	'text-embedding-3-small',
	{ promptTokens: TOKENS, completionTokens: 0, totalTokens: TOKENS },
	'embedding'
);
const CEILING_USD = EXPECTED.costUsd / 2;

beforeEach(() => {
	sdk.embed.mockReset();
	sdk.embed.mockResolvedValue({ embedding: [0.1, 0.2, 0.3], usage: { tokens: TOKENS } });
});
afterEach(() => {
	vi.unstubAllEnvs();
});

async function setup() {
	vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', String(CEILING_USD));
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
			costMicrousd: usdToMicrousd(EXPECTED.costUsd),
			isEstimated: EXPECTED.estimated,
		}),
	]);
	const status = await t.query(internal.aiRouting.enforcedBudget.getBudgetStatus, {});
	expect(status.daily.spentUsd).toBeCloseTo(EXPECTED.costUsd);
	expect(status.daily.spentUsd).toBeGreaterThan(CEILING_USD);
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
