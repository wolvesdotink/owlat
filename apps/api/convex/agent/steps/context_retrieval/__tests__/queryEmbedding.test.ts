/**
 * Team retrieval's query embedding (and the empty-corpus skip): the step
 * embeds the query ONCE and hands the same vector to the
 * knowledge search and the file search, with the query text still passed to
 * both for their full-text legs. When neither table holds a vector it makes no
 * embedding call at all, and an embedding failure leaves both searches out, as
 * each search did on its own failure before.
 *
 * The embedding SDK and the model factory are mocked; the searches are faked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStepCtx } from '../../__tests__/stepCtx';
import { storedEmbeddingTarget } from '../../../../lib/embeddingSpace';
import type { Id } from '../../../../_generated/dataModel';

const mocks = vi.hoisted(() => ({
	embed: vi.fn(),
	// A hosted embedder: its target needs no revision probe.
	resolveIndexEmbedder: vi.fn(async () => ({
		model: 'mock-embedder',
		target: storedEmbeddingTarget({ embeddingProviderKind: 'openai' }),
	})),
}));

vi.mock('ai', async () => ({ ...(await vi.importActual<object>('ai')), embed: mocks.embed }));
vi.mock('../../../../lib/llmProvider', async () => ({
	...(await vi.importActual<object>('../../../../lib/llmProvider')),
	resolveIndexEmbedder: mocks.resolveIndexEmbedder,
}));

import { contextRetrievalStep } from '../index';

const messageId = 'msg_embed' as Id<'inboundMessages'>;
const SPACE_ID = 'space_active' as Id<'embeddingSpaces'>;
// Surrounding whitespace, which the searches have always trimmed before embedding.
const SUBJECT = '   Can you confirm my order shipped?';
const BODY = 'Hi, I placed order 123 last week — has it shipped yet?\n\n  ';
const input = { inboundMessageId: messageId };

function makeCtx(hasVectors: boolean) {
	const searches: Array<{ name: 'knowledge' | 'files'; args: Record<string, unknown> }> = [];
	const vectorChecks: unknown[] = [];
	const ledger: Array<Record<string, unknown>> = [];
	const ctx = makeStepCtx<Parameters<typeof contextRetrievalStep.execute>[0]>({
		queries: {
			getMessage: {
				from: 'sender@example.com',
				to: 'support@owlat.app',
				subject: SUBJECT,
				textBody: BODY,
				receivedAt: Date.now(),
			},
			isGraphRetrievalEnabled: false,
			hasQueryableVectors: (args) => {
				vectorChecks.push(args);
				return hasVectors;
			},
			// The query vector's space is the active one.
			searchTarget: { spaceId: SPACE_ID, slot: 'primary' },
		},
		actions: {
			'files/processing': (args) => {
				searches.push({ name: 'files', args: args as Record<string, unknown> });
				return [];
			},
			knowledge: (args) => {
				searches.push({ name: 'knowledge', args: args as Record<string, unknown> });
				return [];
			},
		},
		mutations: {
			llmUsage: (args) => {
				ledger.push(args as Record<string, unknown>);
				return null;
			},
		},
	});
	return { ctx, searches, vectorChecks, ledger };
}

beforeEach(() => {
	mocks.embed.mockReset();
	mocks.embed.mockResolvedValue({ embedding: [0.25, 0.5, 0.75] });
	mocks.resolveIndexEmbedder.mockClear();
});

describe('contextRetrievalStep — one query embedding', () => {
	it('embeds once and shares the vector with both searches, query text included', async () => {
		const { ctx, searches, vectorChecks, ledger } = makeCtx(true);

		await contextRetrievalStep.execute(ctx, input);

		expect(mocks.embed).toHaveBeenCalledTimes(1);
		// The one embedding is one metered request, under the message's root.
		expect(ledger).toEqual([
			expect.objectContaining({
				feature: 'embedding_knowledge_search',
				task: 'embedding.query',
				plane: 'embedding',
				rootRequestId: `team:${messageId}`,
				requests: [expect.objectContaining({ attempt: 1 })],
			}),
		]);
		// The exact text each search embedded before: its query text, trimmed.
		expect(mocks.embed.mock.calls[0]![0]).toMatchObject({
			value: `${SUBJECT}\n${BODY}`.slice(0, 2000).trim(),
		});
		expect(vectorChecks).toEqual([{ tables: ['knowledgeEntries', 'semanticFiles'] }]);
		expect(searches.map((s) => s.name)).toEqual(['knowledge', 'files']);
		const [knowledge, files] = searches;
		expect(knowledge!.args['embedding']).toHaveLength(1536);
		expect(knowledge!.args['embedding']).toEqual(files!.args['embedding']);
		// Both vector legs filter to the space the vector is in.
		expect(knowledge!.args['embeddingSpaceId']).toBe(SPACE_ID);
		expect(files!.args['embeddingSpaceId']).toBe(SPACE_ID);
		expect((knowledge!.args['embedding'] as number[]).slice(0, 3)).toEqual([0.25, 0.5, 0.75]);
		expect(knowledge!.args['queryText']).toContain('order 123');
		expect(files!.args['queryText']).toBe(knowledge!.args['queryText']);
	});

	it('makes no embedding call when no table holds a vector, and still searches by text', async () => {
		const { ctx, searches } = makeCtx(false);

		await contextRetrievalStep.execute(ctx, input);

		expect(mocks.embed).not.toHaveBeenCalled();
		expect(mocks.resolveIndexEmbedder).not.toHaveBeenCalled();
		expect(searches).toHaveLength(2);
		for (const search of searches) {
			expect(search.args['embedding']).toBeUndefined();
			expect(search.args['queryText']).toContain('order 123');
		}
	});

	it('leaves both searches out when the one embedding fails, as each did before', async () => {
		// Not retriable, so one request (a transient failure retries through the
		// shared policy, as the SDK's own retry did before).
		mocks.embed.mockRejectedValue(Object.assign(new Error('embedder down'), { statusCode: 401 }));
		const { ctx, searches, ledger } = makeCtx(true);

		const { output } = await contextRetrievalStep.execute(ctx, input);

		expect(mocks.embed).toHaveBeenCalledTimes(1);
		// The failed request is still a row.
		expect(ledger).toHaveLength(1);
		expect(searches).toEqual([]);
		expect(output.coverage.knowledge).toBe(false);
		expect(output.coverage.files).toBe(false);
	});
});
