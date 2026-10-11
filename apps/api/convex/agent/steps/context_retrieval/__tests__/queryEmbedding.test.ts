/**
 * Team retrieval's query embedding (ADR-0073, Phase 1c L8 and the empty-corpus
 * skip): the step embeds the query ONCE and hands the same vector to the
 * knowledge search and the file search, with the query text still passed to
 * both for their full-text legs. When neither table holds a vector it makes no
 * embedding call at all, and an embedding failure leaves both searches out, as
 * each search did on its own failure before.
 *
 * The embedding SDK and the model factory are mocked; the searches are faked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStepCtx } from '../../__tests__/stepCtx';
import type { Id } from '../../../../_generated/dataModel';

const mocks = vi.hoisted(() => ({
	embed: vi.fn(),
	resolveEmbeddingModel: vi.fn(async () => 'mock-embedder'),
}));

vi.mock('ai', async () => ({ ...(await vi.importActual<object>('ai')), embed: mocks.embed }));
vi.mock('../../../../lib/llmProvider', async () => ({
	...(await vi.importActual<object>('../../../../lib/llmProvider')),
	resolveEmbeddingModel: mocks.resolveEmbeddingModel,
}));

import { contextRetrievalStep } from '../index';

const messageId = 'msg_embed' as Id<'inboundMessages'>;
const input = { inboundMessageId: messageId };

function makeCtx(hasVectors: boolean) {
	const searches: Array<{ name: 'knowledge' | 'files'; args: Record<string, unknown> }> = [];
	const vectorChecks: unknown[] = [];
	const ctx = makeStepCtx<Parameters<typeof contextRetrievalStep.execute>[0]>({
		queries: {
			getMessage: {
				from: 'sender@example.com',
				to: 'support@owlat.app',
				subject: 'Can you confirm my order shipped?',
				textBody: 'Hi, I placed order 123 last week — has it shipped yet?',
				receivedAt: Date.now(),
			},
			isGraphRetrievalEnabled: false,
			hasQueryableVectors: (args) => {
				vectorChecks.push(args);
				return hasVectors;
			},
		},
		actions: {
			semanticFileProcessing: (args) => {
				searches.push({ name: 'files', args: args as Record<string, unknown> });
				return [];
			},
			knowledge: (args) => {
				searches.push({ name: 'knowledge', args: args as Record<string, unknown> });
				return [];
			},
		},
		mutations: { recordContextTier: null },
	});
	return { ctx, searches, vectorChecks };
}

beforeEach(() => {
	mocks.embed.mockReset();
	mocks.embed.mockResolvedValue({ embedding: [0.25, 0.5, 0.75] });
	mocks.resolveEmbeddingModel.mockClear();
});

describe('contextRetrievalStep — one query embedding', () => {
	it('embeds once and shares the vector with both searches, query text included', async () => {
		const { ctx, searches, vectorChecks } = makeCtx(true);

		await contextRetrievalStep.execute(ctx, input);

		expect(mocks.embed).toHaveBeenCalledTimes(1);
		expect(vectorChecks).toEqual([{ tables: ['knowledgeEntries', 'semanticFiles'] }]);
		expect(searches.map((s) => s.name)).toEqual(['knowledge', 'files']);
		const [knowledge, files] = searches;
		expect(knowledge!.args['embedding']).toHaveLength(1536);
		expect(knowledge!.args['embedding']).toEqual(files!.args['embedding']);
		expect((knowledge!.args['embedding'] as number[]).slice(0, 3)).toEqual([0.25, 0.5, 0.75]);
		expect(knowledge!.args['queryText']).toContain('order 123');
		expect(files!.args['queryText']).toBe(knowledge!.args['queryText']);
	});

	it('makes no embedding call when no table holds a vector, and still searches by text', async () => {
		const { ctx, searches } = makeCtx(false);

		await contextRetrievalStep.execute(ctx, input);

		expect(mocks.embed).not.toHaveBeenCalled();
		expect(mocks.resolveEmbeddingModel).not.toHaveBeenCalled();
		expect(searches).toHaveLength(2);
		for (const search of searches) {
			expect(search.args['embedding']).toBeUndefined();
			expect(search.args['queryText']).toContain('order 123');
		}
	});

	it('leaves both searches out when the one embedding fails, as each did before', async () => {
		mocks.embed.mockRejectedValue(new Error('embedder down'));
		const { ctx, searches } = makeCtx(true);

		const { output } = await contextRetrievalStep.execute(ctx, input);

		expect(mocks.embed).toHaveBeenCalledTimes(1);
		expect(searches).toEqual([]);
		expect(output.coverage.knowledge).toBe(false);
		expect(output.coverage.files).toBe(false);
	});
});
