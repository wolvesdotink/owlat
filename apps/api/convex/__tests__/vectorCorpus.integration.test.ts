/**
 * The empty-corpus skip (ADR-0073, Phase 1c): a retrieval search embeds its
 * query only when the table holds a vector it could return. With none, it
 * makes no embedding call and still runs the full-text leg, which is all a
 * vector search over an empty index came to. With vectors, it embeds as
 * before. Only vectors of the active space count, and only while that space is
 * the configured one (embed lane): nothing else is searchable by vector.
 *
 * The embedding SDK and the model factory are mocked; the existence check,
 * the searches and the indexes are convex-test's.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { storedEmbeddingTarget } from '../lib/embeddingSpace';
import type { Id } from '../_generated/dataModel';
import {
	configureLocalEmbedder,
	seedEmbeddingSpace,
	TEST_LOCAL_SPACE,
} from './helpers/embeddingSpaces';

const mocks = vi.hoisted(() => ({
	embed: vi.fn(),
	// The configured local embedder (the stored row each test writes).
	resolveIndexEmbedder: vi.fn(),
}));

vi.mock('ai', async () => ({ ...(await vi.importActual<object>('ai')), embed: mocks.embed }));
vi.mock('../lib/llmProvider', async () => ({
	...(await vi.importActual<object>('../lib/llmProvider')),
	resolveIndexEmbedder: mocks.resolveIndexEmbedder,
}));

const modules = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).filter(
		([path]) => !path.includes('sesActions') && !path.includes('visualizationAgent')
	)
);

type Harness = ReturnType<typeof convexTest>;

const DIM = 1536;
const unit = (at: number) => Array.from({ length: DIM }, (_, i) => (i === at ? 1 : 0));

/** A vector is stamped with `embeddingGeneratedAt`, exactly as every vector writer does. */
const stamp = (embedding: number[]) =>
	embedding.length > 0 ? { embeddingGeneratedAt: Date.now() } : {};

async function insertEntry(
	t: Harness,
	title: string,
	embedding: number[],
	space?: Id<'embeddingSpaces'>
) {
	const now = Date.now();
	return t.run((ctx) =>
		ctx.db.insert('knowledgeEntries', {
			entryType: 'fact',
			title,
			content: title,
			sourceType: 'email',
			embedding,
			...stamp(embedding),
			...(space ? { embeddingSpaceId: space } : {}),
			confidence: 0.9,
			lastValidatedAt: now,
			searchableText: title,
			createdAt: now,
			updatedAt: now,
		})
	);
}

async function insertFile(
	t: Harness,
	filename: string,
	embedding: number[],
	space?: Id<'embeddingSpaces'>
) {
	return t.run((ctx) =>
		ctx.db.insert('semanticFiles', {
			filename,
			mimeType: 'text/plain',
			fileSize: 4,
			sourceType: 'upload',
			embedding,
			...stamp(embedding),
			...(space ? { embeddingSpaceId: space } : {}),
			searchableText: filename,
			version: 1,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	);
}

/** A space; the active one is the configured local default's unless told otherwise. */
async function insertSpace(t: Harness, state: 'active' | 'retired', model?: string) {
	return seedEmbeddingSpace(t, {
		state,
		identity: {
			...TEST_LOCAL_SPACE,
			model: model ?? (state === 'active' ? TEST_LOCAL_SPACE.model : 'old-model'),
		},
	});
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
	mocks.resolveIndexEmbedder.mockReset();
	mocks.resolveIndexEmbedder.mockImplementation(async () => ({
		model: 'mock-embedder',
		target: storedEmbeddingTarget({ embeddingProviderKind: 'local' }),
	}));
	// The local server answers no revision probe (not Ollama): revision unknown.
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('not found', { status: 404 }))
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A configured deployment with its active space. */
async function configured(t: Harness): Promise<Id<'embeddingSpaces'>> {
	await configureLocalEmbedder(t);
	return insertSpace(t, 'active');
}

describe('knowledge/vectorCorpus.hasQueryableVectors', () => {
	it('is false for empty tables and for a short table whose rows have no vector', async () => {
		const t = convexTest(schema, modules);
		expect(await hasVectors(t, ['knowledgeEntries', 'semanticFiles'])).toBe(false);

		await insertEntry(t, 'pending entry', []);
		await insertFile(t, 'pending.txt', []);
		expect(await hasVectors(t, ['knowledgeEntries', 'semanticFiles'])).toBe(false);
	});

	it('is true as soon as one searched table holds a vector in the active space', async () => {
		const t = convexTest(schema, modules);
		const active = await configured(t);
		await insertFile(t, 'contract.pdf', unit(7), active);
		expect(await hasVectors(t, ['knowledgeEntries'])).toBe(false);
		expect(await hasVectors(t, ['semanticFiles'])).toBe(true);
		expect(await hasVectors(t, ['knowledgeEntries', 'semanticFiles'])).toBe(true);
	});

	it('does not count unknown vectors (written before provenance)', async () => {
		const t = convexTest(schema, modules);
		await configured(t);
		await insertEntry(t, 'legacy vector', unit(1));
		expect(await hasVectors(t, ['knowledgeEntries'])).toBe(false);
	});

	it('stays false however many vectorless rows a table holds', async () => {
		const t = convexTest(schema, modules);
		await configured(t);
		for (let i = 0; i < 12; i++) await insertEntry(t, `pending ${i}`, []);
		expect(await hasVectors(t, ['knowledgeEntries'])).toBe(false);
	});

	it('counts the active space and ignores a retired one', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		const retired = await insertSpace(t, 'retired');
		await insertEntry(t, 'old vector', unit(1), retired);
		expect(await hasVectors(t, ['knowledgeEntries'])).toBe(false);

		const active = await insertSpace(t, 'active');
		await insertEntry(t, 'current vector', unit(2), active);
		expect(await hasVectors(t, ['knowledgeEntries'])).toBe(true);
	});

	it('is false while the active space is not the configured one (a switch not yet landed)', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t, 'mxbai-embed-large');
		const active = await insertSpace(t, 'active');
		await insertEntry(t, 'nomic vector', unit(2), active);
		expect(await hasVectors(t, ['knowledgeEntries'])).toBe(false);
	});

	it('reads the secondary column of a space that lives there', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		const active = await seedEmbeddingSpace(t, { slot: 'secondary' });
		const id = await insertEntry(t, 'rebuilt vector', []);
		expect(await hasVectors(t, ['knowledgeEntries'])).toBe(false);
		await t.run((ctx) =>
			ctx.db.patch(id, { secondaryEmbedding: unit(2), secondaryEmbeddingSpaceId: active })
		);
		expect(await hasVectors(t, ['knowledgeEntries'])).toBe(true);
	});
});

describe('semanticSearch — empty-corpus skip', () => {
	it('makes no embedding call over a vectorless corpus and still finds by text', async () => {
		const t = convexTest(schema, modules);
		await configured(t);
		await insertEntry(t, 'Zephyr launch date', []);
		for (let i = 0; i < 9; i++) await insertEntry(t, `manual note ${i}`, []);

		const results = await searchKnowledge(t, 'Zephyr');

		expect(mocks.embed).not.toHaveBeenCalled();
		expect(mocks.resolveIndexEmbedder).not.toHaveBeenCalled();
		expect(results.map((r) => r.title)).toEqual(['Zephyr launch date']);
	});

	it('embeds the trimmed query once when the corpus has vectors', async () => {
		const t = convexTest(schema, modules);
		const active = await configured(t);
		await insertEntry(t, 'Shipping policy', unit(3), active);

		const results = await searchKnowledge(t, '  when does it ship \n');

		expect(mocks.embed).toHaveBeenCalledTimes(1);
		expect(mocks.embed.mock.calls[0]![0]).toMatchObject({ value: 'when does it ship' });
		expect(results.map((r) => r.title)).toEqual(['Shipping policy']);
	});

	it('file search makes no embedding call over a vectorless table', async () => {
		const t = convexTest(schema, modules);
		for (let i = 0; i < 9; i++) await insertFile(t, `notes-${i}.txt`, []);

		await t.action(internal.semanticFileProcessing.semanticSearch, {
			queryText: 'notes',
			scopeToContact: 'org-wide',
			mailCaptures: 'all',
		});

		expect(mocks.embed).not.toHaveBeenCalled();
	});
});
