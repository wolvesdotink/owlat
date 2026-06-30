import { convexTest } from 'convex-test';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { STRUCTURAL_THREAD_FANOUT } from '../knowledge/edges';
import { normalizeForHash } from '../lib/knowledgeEdges';
import {
	createTestContact,
	createTestKnowledgeEntry,
	enableFeatures,
} from './factories';
import type { Doc, Id } from '../_generated/dataModel';

// Heavy action / LLM modules aren't needed for the structural-linker mutations
// and pull in node-only deps, so trim them from the convex-test module map
// (same idiom as knowledgeGraph.integration.test.ts).
const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') &&
		!path.includes('agentSecurity') &&
		!path.includes('agentContext') &&
		!path.includes('agentClassifier') &&
		!path.includes('agentDrafter') &&
		!path.includes('agentRouter') &&
		!path.includes('agent/walker') &&
		!path.includes('agent/steps/index') &&
		!path.includes('agent/steps/shared') &&
		!path.includes('agent/steps/classify') &&
		!path.includes('agent/steps/draft') &&
		!path.includes('knowledgeExtraction') &&
		!path.includes('semanticFileProcessing') &&
		!path.includes('visualizationAgent') &&
		!path.includes('llmProvider')
	)
);

async function allRelations(
	t: ReturnType<typeof convexTest>,
): Promise<Doc<'knowledgeRelations'>[]> {
	return await t.run(async (ctx) => ctx.db.query('knowledgeRelations').collect());
}

describe('knowledge.edges.linkStructural', () => {
	it('builds the relates_to clique among same-batch entries', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);

		const ids = await t.run(async (ctx) => {
			const a = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'A' }));
			const b = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'B' }));
			const c = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'C' }));
			return [a, b, c];
		});

		await t.mutation(internal.knowledge.edges.linkStructural, {
			entryIds: ids,
			sourceType: 'agent_extracted',
			sourceId: 'msg-1',
		});

		const rels = await allRelations(t);
		// 3 entries → 3 choose 2 = 3 undirected pairs.
		expect(rels).toHaveLength(3);
		for (const r of rels) {
			expect(r.relationType).toBe('relates_to');
			expect(r.confidenceTag).toBe('extracted');
			expect(r.confidence).toBe(1.0);
			expect(r.provenance).toBe('deterministic');
		}
	});

	it('links each entry to pre-existing same-thread entries, capped at the fan-out', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);

		const { threadId, batchId } = await t.run(async (ctx) => {
			const now = Date.now();
			const threadId = await ctx.db.insert('conversationThreads', {
				subject: 'Thread',
				normalizedSubject: 'thread',
				contactIdentifier: 'thread@example.com',
				status: 'open' as const,
				messageCount: 1,
				lastMessageAt: now,
				firstMessageAt: now,
				createdAt: now,
			});
			// More pre-existing same-thread entries than the fan-out cap.
			for (let i = 0; i < STRUCTURAL_THREAD_FANOUT + 3; i++) {
				await ctx.db.insert(
					'knowledgeEntries',
					createTestKnowledgeEntry({ title: `pre-${i}`, threadId }),
				);
			}
			// The freshly-ingested entry carries no threadId of its own — the fan-out
			// is driven by the threadId arg, so it never self-links.
			const batchId = await ctx.db.insert(
				'knowledgeEntries',
				createTestKnowledgeEntry({ title: 'new' }),
			);
			return { threadId, batchId };
		});

		await t.mutation(internal.knowledge.edges.linkStructural, {
			entryIds: [batchId],
			threadId,
			sourceType: 'agent_extracted',
			sourceId: 'msg-2',
		});

		const rels = await allRelations(t);
		// Capped: at most STRUCTURAL_THREAD_FANOUT same-thread neighbors are linked.
		expect(rels).toHaveLength(STRUCTURAL_THREAD_FANOUT);
		for (const r of rels) {
			expect(r.fromEntryId).toBe(batchId);
			expect(r.relationType).toBe('relates_to');
			expect(r.provenance).toBe('deterministic');
		}
	});

	it('is idempotent on re-run (no duplicate rows via by_pair)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);

		const ids = await t.run(async (ctx) => {
			const a = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'A' }));
			const b = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'B' }));
			return [a, b];
		});

		const args = {
			entryIds: ids,
			sourceType: 'agent_extracted' as const,
			sourceId: 'msg-3',
		};
		await t.mutation(internal.knowledge.edges.linkStructural, args);
		await t.mutation(internal.knowledge.edges.linkStructural, args);

		const rels = await allRelations(t);
		expect(rels).toHaveLength(1); // one pair, merged not duplicated
	});

	it('does NOT link entries across contact scope', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']);

		const ids = await t.run(async (ctx) => {
			const contactA = await ctx.db.insert('contacts', createTestContact());
			const contactB = await ctx.db.insert('contacts', createTestContact());
			const a = await ctx.db.insert(
				'knowledgeEntries',
				createTestKnowledgeEntry({ title: 'A', contactIds: [contactA] }),
			);
			const b = await ctx.db.insert(
				'knowledgeEntries',
				createTestKnowledgeEntry({ title: 'B', contactIds: [contactB] }),
			);
			return [a, b] as Id<'knowledgeEntries'>[];
		});

		await t.mutation(internal.knowledge.edges.linkStructural, {
			entryIds: ids,
			sourceType: 'agent_extracted',
			sourceId: 'msg-4',
		});

		const rels = await allRelations(t);
		expect(rels).toHaveLength(0); // disjoint contact scopes are never bridged
	});

	it('is a no-op when ai.knowledge is disabled', async () => {
		const t = convexTest(schema, modules); // no enableFeatures → ai.knowledge off

		const ids = await t.run(async (ctx) => {
			const a = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'A' }));
			const b = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'B' }));
			return [a, b];
		});

		await t.mutation(internal.knowledge.edges.linkStructural, {
			entryIds: ids,
			sourceType: 'agent_extracted',
			sourceId: 'msg-5',
		});

		const rels = await allRelations(t);
		expect(rels).toHaveLength(0);
	});
});

describe('knowledge.graph.saveEntry content-hash dedup', () => {
	it('returns the existing id for byte-identical normalized content from a different source', async () => {
		const t = convexTest(schema, modules);

		const title = 'Acme uses Postgres';
		const content = 'Their primary datastore is Postgres 16.';
		// Same fact, restated with different casing/spacing → same normalized hash.
		const title2 = '  acme   USES   postgres ';
		const content2 = 'their PRIMARY  datastore is postgres 16. ';
		const hash = createHash('sha256').update(normalizeForHash(title, content)).digest('hex');
		const hash2 = createHash('sha256').update(normalizeForHash(title2, content2)).digest('hex');
		expect(hash2).toBe(hash); // normalization makes the two collide

		const firstId = await t.mutation(internal.knowledge.graph.saveEntry, {
			entryType: 'fact',
			title,
			content,
			sourceType: 'email',
			sourceId: 'source-A',
			embedding: [],
			confidence: 0.9,
			contentHash: hash,
		});

		const secondId = await t.mutation(internal.knowledge.graph.saveEntry, {
			entryType: 'fact',
			title: title2,
			content: content2,
			sourceType: 'email',
			sourceId: 'source-B', // different source → same-source leg can't catch it
			embedding: [],
			confidence: 0.9,
			contentHash: hash2,
		});

		expect(secondId).toBe(firstId); // deduped via by_content_hash

		const entries = await t.run(async (ctx) =>
			ctx.db.query('knowledgeEntries').collect(),
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.contentHash).toBe(hash);
	});

	it('keeps separate rows when the same content has a different contact scope', async () => {
		const t = convexTest(schema, modules);

		const title = 'Shared fact';
		const content = 'Identical content body.';
		const hash = createHash('sha256').update(normalizeForHash(title, content)).digest('hex');

		const contactId = await t.run(async (ctx) =>
			ctx.db.insert('contacts', createTestContact()),
		);

		const orgGeneralId = await t.mutation(internal.knowledge.graph.saveEntry, {
			entryType: 'fact',
			title,
			content,
			sourceType: 'email',
			sourceId: 'source-A',
			embedding: [],
			confidence: 0.9,
			contentHash: hash,
		});

		const contactScopedId = await t.mutation(internal.knowledge.graph.saveEntry, {
			entryType: 'fact',
			title,
			content,
			sourceType: 'email',
			sourceId: 'source-B',
			contactIds: [contactId],
			embedding: [],
			confidence: 0.9,
			contentHash: hash,
		});

		// Different contact scope ⇒ NOT deduped (dedup would widen visibility).
		expect(contactScopedId).not.toBe(orgGeneralId);
		const entries = await t.run(async (ctx) =>
			ctx.db.query('knowledgeEntries').collect(),
		);
		expect(entries).toHaveLength(2);
	});
});
