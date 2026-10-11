/**
 * The empty-corpus skip (ADR-0073, Phase 1c): a retrieval search embeds its
 * query only when the table holds a vector it could return. With none, it
 * makes no embedding call and still runs the full-text leg, which is all a
 * vector search over an empty index came to. With vectors, it embeds as
 * before.
 *
 * The embedding SDK and the model factory are mocked; the existence check,
 * the searches and the indexes are convex-test's.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';

const mocks = vi.hoisted(() => ({
	embed: vi.fn(),
	resolveEmbeddingModel: vi.fn(async () => 'mock-embedder'),
}));

vi.mock('ai', async () => ({ ...(await vi.importActual<object>('ai')), embed: mocks.embed }));
vi.mock('../lib/llmProvider', async () => ({
	...(await vi.importActual<object>('../lib/llmProvider')),
	resolveEmbeddingModel: mocks.resolveEmbeddingModel,
}));

const modules = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).filter(
		([path]) => !path.includes('sesActions') && !path.includes('visualizationAgent')
	)
);

type Harness = ReturnType<typeof convexTest>;

const DIM = 1536;
const unit = (at: number) => Array.from({ length: DIM }, (_, i) => (i === at ? 1 : 0));

async function insertEntry(t: Harness, title: string, embedding: number[]) {
	const now = Date.now();
	return t.run((ctx) =>
		ctx.db.insert('knowledgeEntries', {
			entryType: 'fact',
			title,
			content: title,
			sourceType: 'email',
			embedding,
			confidence: 0.9,
			lastValidatedAt: now,
			searchableText: title,
			createdAt: now,
			updatedAt: now,
		})
	);
}

async function insertFile(t: Harness, filename: string, embedding: number[]) {
	return t.run((ctx) =>
		ctx.db.insert('semanticFiles', {
			filename,
			mimeType: 'text/plain',
			fileSize: 4,
			sourceType: 'upload',
			embedding,
			searchableText: filename,
			version: 1,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	);
}

const hasVectors = (t: Harness, tables: Array<'knowledgeEntries' | 'semanticFiles'>) =>
	t.query(internal.knowledge.vectorCorpus.hasQueryableVectors, { tables });

const searchKnowledge = (t: Harness, queryText: string) =>
	t.action(internal.knowledge.retrieval.semanticSearch, {
		queryText,
		scopeToContact: 'org-wide',
		includeInboxDerived: true,
	});

beforeEach(() => {
	mocks.embed.mockReset();
	mocks.embed.mockResolvedValue({ embedding: unit(3) });
	mocks.resolveEmbeddingModel.mockClear();
});

describe('knowledge/vectorCorpus.hasQueryableVectors', () => {
	it('is false for empty tables and for a short table whose rows have no vector', async () => {
		const t = convexTest(schema, modules);
		expect(await hasVectors(t, ['knowledgeEntries', 'semanticFiles'])).toBe(false);

		await insertEntry(t, 'pending entry', []);
		await insertFile(t, 'pending.txt', []);
		expect(await hasVectors(t, ['knowledgeEntries', 'semanticFiles'])).toBe(false);
	});

	it('is true as soon as one searched table holds a vector', async () => {
		const t = convexTest(schema, modules);
		await insertFile(t, 'contract.pdf', unit(7));
		expect(await hasVectors(t, ['knowledgeEntries'])).toBe(false);
		expect(await hasVectors(t, ['semanticFiles'])).toBe(true);
		expect(await hasVectors(t, ['knowledgeEntries', 'semanticFiles'])).toBe(true);
	});

	it('answers yes when a full sample holds no vector, since one may sit further on', async () => {
		const t = convexTest(schema, modules);
		for (let i = 0; i < 8; i++) await insertEntry(t, `pending ${i}`, []);
		expect(await hasVectors(t, ['knowledgeEntries'])).toBe(true);
	});
});

describe('semanticSearch — empty-corpus skip', () => {
	it('makes no embedding call over a vectorless corpus and still finds by text', async () => {
		const t = convexTest(schema, modules);
		await insertEntry(t, 'Zephyr launch date', []);

		const results = await searchKnowledge(t, 'Zephyr');

		expect(mocks.embed).not.toHaveBeenCalled();
		expect(mocks.resolveEmbeddingModel).not.toHaveBeenCalled();
		expect(results.map((r) => r.title)).toEqual(['Zephyr launch date']);
	});

	it('embeds once and searches by vector when the corpus has vectors', async () => {
		const t = convexTest(schema, modules);
		await insertEntry(t, 'Shipping policy', unit(3));

		const results = await searchKnowledge(t, 'when does it ship');

		expect(mocks.embed).toHaveBeenCalledTimes(1);
		expect(results.map((r) => r.title)).toEqual(['Shipping policy']);
	});

	it('file search makes no embedding call over a vectorless table', async () => {
		const t = convexTest(schema, modules);
		await insertFile(t, 'notes.txt', []);

		await t.action(internal.semanticFileProcessing.semanticSearch, {
			queryText: 'notes',
			scopeToContact: 'org-wide',
		});

		expect(mocks.embed).not.toHaveBeenCalled();
	});
});
