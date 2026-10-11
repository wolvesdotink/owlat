/**
 * The retrieval half of the embedding-space check (`vectorHitsInCurrentSpace`).
 *
 * The race: a search embeds its query in space A against an empty corpus, an
 * allowed save switches to B, a B vector commits, and only then does the A query
 * run its vector search. Its vector hits are in B and must be dropped; the
 * lexical leg may still answer. The embedder is real resolution with a mocked
 * `embed`, which performs the switch while the query is "in flight".
 */
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { embeddingSpaceKey, resolvedEmbeddingSpace } from '../lib/embeddingSpace';

const DIM = 1536;
function unit(at: number): number[] {
	const vec = Array.from({ length: DIM }, () => 0);
	vec[at] = 1;
	return vec;
}

/** Runs inside `embed()`, i.e. after the query resolved its space, before it searches. */
const inFlight = vi.hoisted(() => ({ duringEmbed: null as null | (() => Promise<void>) }));

vi.mock('ai', async () => {
	const actual = await vi.importActual<typeof import('ai')>('ai');
	return {
		...actual,
		embed: vi.fn(async () => {
			await inFlight.duringEmbed?.();
			return { embedding: unit(5), usage: { tokens: 1 } };
		}),
	};
});

const modules = import.meta.glob('../**/*.*s');

type T = ReturnType<typeof convexTest>;

async function configureLocalEmbedder(t: T, embeddingModel: string | undefined) {
	const now = Date.now();
	await t.run(async (ctx) => {
		const existing = await ctx.db.query('aiProviderConfig').first();
		const fields = {
			languageProviderKind: 'openaiCompatible' as const,
			languageBaseUrl: 'http://localhost:11434/v1',
			modelFast: 'qwen3.6:27b',
			modelCapable: 'qwen3.6:27b',
			embeddingProviderKind: 'local' as const,
			embeddingModel,
			embeddingModelVersion: existing ? existing.embeddingModelVersion + 1 : 1,
			updatedAt: now,
		};
		if (existing) await ctx.db.patch(existing._id, fields);
		else await ctx.db.insert('aiProviderConfig', fields);
	});
}

const currentKey = (t: T) =>
	t.run(async (ctx) =>
		embeddingSpaceKey(resolvedEmbeddingSpace(await ctx.db.query('aiProviderConfig').first()))
	);

afterEach(() => {
	inFlight.duringEmbed = null;
});

describe('vector search after an in-flight embedding-space switch', () => {
	it('drops knowledge vector hits from the new space and keeps lexical hits', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t, undefined); // space A: nomic
		inFlight.duringEmbed = async () => {
			// Allowed: the corpus is empty. Then a B vector commits.
			await configureLocalEmbedder(t, 'mxbai-embed-large');
			await t.mutation(internal.knowledge.graph.saveEntry, {
				entryType: 'fact',
				title: 'Invoices go out in EUR',
				content: 'Invoices go out in EUR',
				sourceType: 'manual',
				embedding: unit(5),
				confidence: 0.9,
				embeddingSpaceKey: await currentKey(t),
			});
		};

		const vectorOnly = await t.action(internal.knowledge.retrieval.semanticSearch, {
			queryText: 'currency preference',
			scopeToContact: 'org-wide',
			includeInboxDerived: true,
		});
		expect(vectorOnly).toEqual([]);

		inFlight.duringEmbed = null;
		// The same B entry, queried in B, is a vector hit.
		const inB = await t.action(internal.knowledge.retrieval.semanticSearch, {
			queryText: 'currency preference',
			scopeToContact: 'org-wide',
			includeInboxDerived: true,
		});
		expect(inB.map((e) => e.title)).toEqual(['Invoices go out in EUR']);
		expect(inB[0]!._score).toBeGreaterThan(0);

		// A stale A query still gets a lexical match, with no vector score.
		const lexical = await t.action(internal.knowledge.retrieval.semanticSearch, {
			queryText: 'EUR',
			embedding: unit(5),
			embeddingSpaceKey: 'stale-space-a',
			scopeToContact: 'org-wide',
			includeInboxDerived: true,
		});
		expect(lexical.map((e) => ({ title: e.title, score: e._score }))).toEqual([
			{ title: 'Invoices go out in EUR', score: 0 },
		]);
	});

	it('drops file vector hits from the new space', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t, undefined);
		inFlight.duringEmbed = async () => {
			await configureLocalEmbedder(t, 'mxbai-embed-large');
			const now = Date.now();
			const fileId = await t.run((ctx) =>
				ctx.db.insert('semanticFiles', {
					filename: 'rates.txt',
					mimeType: 'text/plain',
					fileSize: 5,
					sourceType: 'upload',
					version: 1,
					embedding: [],
					searchableText: 'rates.txt',
					createdAt: now,
					updatedAt: now,
				})
			);
			await t.mutation(internal.semanticFiles.updateProcessedMetadata, {
				fileId,
				embedding: unit(5),
				embeddingSpaceKey: await currentKey(t),
			});
		};

		const stale = await t.action(internal.semanticFileProcessing.semanticSearch, {
			queryText: 'currency preference',
			scopeToContact: 'org-wide',
		});
		expect(stale).toEqual([]);

		inFlight.duringEmbed = null;
		const inB = await t.action(internal.semanticFileProcessing.semanticSearch, {
			queryText: 'currency preference',
			scopeToContact: 'org-wide',
		});
		expect(inB.map((f) => f.filename)).toEqual(['rates.txt']);
	});

	it('drops the vector hits of a previous-release caller that sends no space key', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t, undefined);
		await t.mutation(internal.knowledge.graph.saveEntry, {
			entryType: 'fact',
			title: 'Invoices go out in EUR',
			content: 'Invoices go out in EUR',
			sourceType: 'manual',
			embedding: unit(5),
			confidence: 0.9,
			embeddingSpaceKey: await currentKey(t),
		});

		const legacy = await t.action(internal.knowledge.retrieval.semanticSearch, {
			embedding: unit(5),
			scopeToContact: 'org-wide',
			includeInboxDerived: true,
		});
		expect(legacy).toEqual([]);
		const current = await t.action(internal.knowledge.retrieval.semanticSearch, {
			embedding: unit(5),
			embeddingSpaceKey: await currentKey(t),
			scopeToContact: 'org-wide',
			includeInboxDerived: true,
		});
		expect(current).toHaveLength(1);
	});
});
