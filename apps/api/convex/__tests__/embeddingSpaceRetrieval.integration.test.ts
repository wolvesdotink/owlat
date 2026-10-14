/**
 * Space-filtered retrieval (ADR-0073, Phase 1a provenance and D8).
 *
 * Every vector leg searches exactly one space: the space its query vector is
 * in, and only while that space is active. Rows of other spaces and rows with
 * no space (written before provenance) never reach a vector leg; the full-text
 * leg still finds them. Real space resolution and commits; `embed` is mocked
 * and the local server answers no revision probe (fetch returns 404).
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ai from 'ai';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	configureLocalEmbedder,
	measuredLocalSpace,
	seedEmbeddingSpace,
	stampedIn,
	TEST_LOCAL_SPACE,
} from './helpers/embeddingSpaces';

const DIM = 1536;
function unit(at: number): number[] {
	return Array.from({ length: DIM }, (_, i) => (i === at ? 1 : 0));
}

const embedMock = vi.hoisted(() => ({ vector: [] as number[] }));
vi.mock('ai', async () => {
	const actual = await vi.importActual<typeof Ai>('ai');
	return {
		...actual,
		embed: vi.fn(async () => ({ embedding: embedMock.vector, usage: { tokens: 1 } })),
	};
});

const modules = import.meta.glob('../**/*.*s');
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
	// Scheduled work (the re-embed kickoff a switch schedules) stays queued: these
	// tests look at retrieval alone.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	embedMock.vector = unit(5);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('not found', { status: 404 }))
	);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function insertEntry(
	t: T,
	title: string,
	embedding: number[],
	stamp: Record<string, unknown> = {}
): Promise<Id<'knowledgeEntries'>> {
	const now = Date.now();
	return t.run((ctx) =>
		ctx.db.insert('knowledgeEntries', {
			entryType: 'fact',
			title,
			content: title,
			sourceType: 'manual',
			embedding,
			...stamp,
			confidence: 0.9,
			lastValidatedAt: now,
			searchableText: title,
			createdAt: now,
			updatedAt: now,
		})
	);
}

const search = (t: T, args: Record<string, unknown>) =>
	t.action(internal.knowledge.retrieval.semanticSearch, {
		scopeToContact: 'org-wide',
		includeInboxDerived: true,
		...args,
	});

const scored = (results: Array<{ title: string; _score: number }>) =>
	results.map((r) => ({ title: r.title, isVectorHit: r._score > 0 }));

describe('the vector leg searches one space', () => {
	it('excludes unknown rows and rows of other spaces; the full-text leg still finds them', async () => {
		const t = convexTest(schema, modules);
		const active = await seedEmbeddingSpace(t);
		const retired = await seedEmbeddingSpace(t, {
			state: 'retired',
			identity: { ...TEST_LOCAL_SPACE, model: 'mxbai-embed-large' },
		});
		await insertEntry(t, 'active zephyr', unit(5), stampedIn(active, 'fact'));
		await insertEntry(t, 'legacy zephyr', unit(5), { embeddingGeneratedAt: 1 });
		await insertEntry(t, 'retired zephyr', unit(5), stampedIn(retired, 'fact'));

		const vectorOnly = await search(t, { embedding: unit(5), embeddingSpaceId: active });
		expect(vectorOnly.map((r) => r.title)).toEqual(['active zephyr']);

		// With query text, the other rows come back through full-text only.
		const hybrid = await search(t, {
			queryText: 'zephyr',
			embedding: unit(5),
			embeddingSpaceId: active,
		});
		expect(scored(hybrid)).toEqual(
			expect.arrayContaining([
				{ title: 'active zephyr', isVectorHit: true },
				{ title: 'legacy zephyr', isVectorHit: false },
				{ title: 'retired zephyr', isVectorHit: false },
			])
		);
	});

	it('has no vector leg for a vector without a space, or in a space that is not active', async () => {
		const t = convexTest(schema, modules);
		const active = await seedEmbeddingSpace(t);
		const retired = await seedEmbeddingSpace(t, {
			state: 'retired',
			identity: { ...TEST_LOCAL_SPACE, model: 'mxbai-embed-large' },
		});
		await insertEntry(t, 'retired fact', unit(5), stampedIn(retired, 'fact'));
		await insertEntry(t, 'active fact', unit(5), stampedIn(active, 'fact'));

		expect(await search(t, { embedding: unit(5) })).toEqual([]);
		expect(await search(t, { embedding: unit(5), embeddingSpaceId: retired })).toEqual([]);
	});

	it('filters a typed search on the space-and-type key', async () => {
		const t = convexTest(schema, modules);
		const active = await seedEmbeddingSpace(t);
		await insertEntry(t, 'a fact', unit(5), stampedIn(active, 'fact'));
		const decision = await insertEntry(t, 'a decision', unit(5), stampedIn(active, 'decision'));
		await t.run((ctx) => ctx.db.patch(decision, { entryType: 'decision' }));

		const facts = await search(t, {
			embedding: unit(5),
			embeddingSpaceId: active,
			entryType: 'fact',
		});
		expect(facts.map((r) => r.title)).toEqual(['a fact']);
	});

	it('searches the secondary column of a space that lives there', async () => {
		const t = convexTest(schema, modules);
		const active = await seedEmbeddingSpace(t, { slot: 'secondary' });
		const id = await insertEntry(t, 'rebuilt fact', []);
		await t.run((ctx) =>
			ctx.db.patch(id, {
				secondaryEmbedding: unit(5),
				secondaryEmbeddingSpaceId: active,
				secondaryEmbeddingSpaceEntryKey: `${active}:fact`,
			})
		);
		const hits = await search(t, { embedding: unit(5), embeddingSpaceId: active });
		expect(hits.map((r) => r.title)).toEqual(['rebuilt fact']);
		const typed = await search(t, {
			embedding: unit(5),
			embeddingSpaceId: active,
			entryType: 'fact',
		});
		expect(typed.map((r) => r.title)).toEqual(['rebuilt fact']);
	});

	it('files: the same filter on the file index', async () => {
		const t = convexTest(schema, modules);
		const active = await seedEmbeddingSpace(t);
		const now = Date.now();
		for (const [filename, stamp] of [
			['current.txt', stampedIn(active)],
			['legacy.txt', { embeddingGeneratedAt: 1 }],
		] as const) {
			await t.run((ctx) =>
				ctx.db.insert('semanticFiles', {
					filename,
					mimeType: 'text/plain',
					fileSize: 5,
					sourceType: 'upload',
					version: 1,
					embedding: unit(5),
					...stamp,
					searchableText: filename,
					createdAt: now,
					updatedAt: now,
				})
			);
		}
		const hits = await t.action(internal.semanticFileProcessing.semanticSearch, {
			embedding: unit(5),
			embeddingSpaceId: active,
			scopeToContact: 'org-wide',
			mailCaptures: 'all',
		});
		expect(hits.map((f) => f.filename)).toEqual(['current.txt']);
	});
});

describe('a query embedded here searches its own space', () => {
	it('finds the configured space, and nothing once the configuration names another', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		// A job commits a vector: the configured space registers and activates.
		await t.mutation(internal.knowledge.graph.saveEntry, {
			entryType: 'fact',
			title: 'Invoices go out in EUR',
			content: 'Invoices go out in EUR',
			sourceType: 'manual',
			embedding: unit(5),
			embeddingSpace: measuredLocalSpace(DIM),
			confidence: 0.9,
		});
		const inSpace = await search(t, { queryText: 'currency preference' });
		expect(scored(inSpace)).toEqual([{ title: 'Invoices go out in EUR', isVectorHit: true }]);

		// D8: switching drops the old vectors from vector search at once.
		await configureLocalEmbedder(t, 'mxbai-embed-large');
		expect(await search(t, { queryText: 'currency preference' })).toEqual([]);
		// The lexical leg still finds the entry.
		expect(scored(await search(t, { queryText: 'EUR' }))).toEqual([
			{ title: 'Invoices go out in EUR', isVectorHit: false },
		]);
	});

	it('a pending switch stops precomputed searches of the old space at once (F5)', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		const nomic = await seedEmbeddingSpace(t);
		await insertEntry(t, 'nomic fact', unit(5), stampedIn(nomic, 'fact'));
		expect(await search(t, { embedding: unit(5), embeddingSpaceId: nomic })).toHaveLength(1);

		// Saved, but no mxbai vector has landed: nomic is still `active` by state.
		await configureLocalEmbedder(t, 'mxbai-embed-large');
		expect(await search(t, { embedding: unit(5), embeddingSpaceId: nomic })).toEqual([]);
		const status = await t.run((ctx) => ctx.db.get(nomic));
		expect(status?.state).toBe('active');
	});

	it('A → B → A: the first space comes back with its vectors, by record not by sample', async () => {
		const t = convexTest(schema, modules);
		const commit = (title: string, model: string, at: number) =>
			t.mutation(internal.knowledge.graph.saveEntry, {
				entryType: 'fact',
				title,
				content: title,
				sourceType: 'manual',
				embedding: unit(at),
				embeddingSpace: { ...measuredLocalSpace(DIM), model },
				confidence: 0.9,
			});
		await configureLocalEmbedder(t);
		await commit('nomic fact', 'nomic-embed-text', 5);
		await configureLocalEmbedder(t, 'mxbai-embed-large');
		await commit('mxbai fact', 'mxbai-embed-large', 5);

		const spaces = await t.run((ctx) => ctx.db.query('embeddingSpaces').collect());
		expect(spaces.map((s) => [s.model, s.state, s.slot])).toEqual([
			['nomic-embed-text', 'retired', 'primary'],
			['mxbai-embed-large', 'active', 'secondary'],
		]);
		expect((await search(t, { queryText: 'q' })).map((r) => r.title)).toEqual(['mxbai fact']);

		// Back to nomic: its vectors were never overwritten, so they are searchable again.
		await configureLocalEmbedder(t, 'nomic-embed-text');
		await commit('second nomic fact', 'nomic-embed-text', 6);
		const back = scored(await search(t, { queryText: 'q' }));
		expect(back).toContainEqual({ title: 'nomic fact', isVectorHit: true });
		expect(back.map((r) => r.title)).not.toContain('mxbai fact');
	});

	it('detects an env override of the local model as a new space', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		await t.mutation(internal.knowledge.graph.saveEntry, {
			entryType: 'fact',
			title: 'nomic fact',
			content: 'nomic fact',
			sourceType: 'manual',
			embedding: unit(5),
			embeddingSpace: measuredLocalSpace(DIM),
			confidence: 0.9,
		});
		vi.stubEnv('LOCAL_EMBEDDING_MODEL', 'mxbai-embed-large');
		// The row did not change; the env did. Its nomic vectors no longer compare.
		expect(await search(t, { queryText: 'q' })).toEqual([]);
		// And a job still holding the nomic space is stale.
		const id = await t.mutation(internal.knowledge.graph.saveEntry, {
			entryType: 'fact',
			title: 'late nomic fact',
			content: 'late nomic fact',
			sourceType: 'manual',
			embedding: unit(6),
			embeddingSpace: measuredLocalSpace(DIM),
			confidence: 0.9,
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.embedding).toEqual([]);
	});
});
