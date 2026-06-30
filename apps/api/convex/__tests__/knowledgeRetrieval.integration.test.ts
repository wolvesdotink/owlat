import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

/**
 * knowledge/retrieval.ts semanticSearch. Uses convex-test's in-memory
 * vectorSearch (cosine) and search-index support. Embeddings are 1536-dim unit
 * vectors (one-hot), so cosine(unit(i), unit(j)) is 1 when i===j and 0
 * otherwise — letting us place entries "near" or "far" from a query precisely.
 */

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('visualizationAgent') &&
			!path.includes('semanticFileProcessing'),
	),
);

const DIM = 1536;
function unit(at: number): number[] {
	const vec = Array.from({ length: DIM }, () => 0);
	vec[at] = 1;
	return vec;
}

type EntrySpec = {
	title: string;
	embedAt: number;
	expiresAt?: number;
	searchableText?: string;
};

async function insertEntry(t: ReturnType<typeof convexTest>, spec: EntrySpec): Promise<Id<'knowledgeEntries'>> {
	const now = Date.now();
	return await t.run(async (ctx) =>
		ctx.db.insert('knowledgeEntries', {
			entryType: 'fact',
			title: spec.title,
			content: spec.title,
			sourceType: 'email',
			embedding: unit(spec.embedAt),
			confidence: 0.9,
			lastValidatedAt: now,
			expiresAt: spec.expiresAt,
			searchableText: spec.searchableText ?? spec.title,
			createdAt: now,
			updatedAt: now,
		}),
	);
}

describe('semanticSearch — expiresAt filtering', () => {
	it('excludes entries whose TTL has lapsed but keeps live + future-dated ones', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await insertEntry(t, { title: 'live fact', embedAt: 5 });
		await insertEntry(t, { title: 'future fact', embedAt: 5, expiresAt: now + 1_000_000 });
		await insertEntry(t, { title: 'expired fact', embedAt: 5, expiresAt: now - 1_000 });

		const results = await t.action(internal.knowledge.retrieval.semanticSearch, {
			embedding: unit(5),
			scopeToContact: 'org-wide',
			limit: 10,
		});

		const titles = results.map((r) => r.title);
		expect(titles).toContain('live fact');
		expect(titles).toContain('future fact');
		expect(titles).not.toContain('expired fact');
	});
});

describe('semanticSearch — hybrid (vector + FTS) recall', () => {
	it('surfaces an exact-token entry the vector leg misses, via the FTS leg', async () => {
		const t = convexTest(schema, modules);
		// Flood the vector neighborhood of the query (embedAt 7) with decoys so a
		// vector-only search fills its window with them. The target shares NONE of
		// that embedding (orthogonal, embedAt 999) — pure vector ranks it last/out
		// — but its searchableText carries the exact order number we query for.
		for (let i = 0; i < 60; i++) {
			await insertEntry(t, { title: `decoy ${i}`, embedAt: 7, searchableText: `unrelated chatter ${i}` });
		}
		await insertEntry(t, {
			title: 'order ABC-12345 shipped',
			embedAt: 999,
			searchableText: 'tracking for order ABC-12345 shipped tuesday',
		});

		const results = await t.action(internal.knowledge.retrieval.semanticSearch, {
			queryText: 'ABC-12345',
			embedding: unit(7),
			scopeToContact: 'org-wide',
			limit: 10,
		});

		// The exact-token hit makes the top results despite zero vector similarity.
		expect(results.map((r) => r.title)).toContain('order ABC-12345 shipped');
	});

	it('still returns vector hits when there is no FTS match (graceful degrade)', async () => {
		const t = convexTest(schema, modules);
		await insertEntry(t, { title: 'a concept', embedAt: 3, searchableText: 'totally different words' });

		const results = await t.action(internal.knowledge.retrieval.semanticSearch, {
			queryText: 'zzzznomatch',
			embedding: unit(3),
			scopeToContact: 'org-wide',
			limit: 10,
		});

		expect(results.map((r) => r.title)).toContain('a concept');
	});
});
