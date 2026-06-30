import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
	createTestContact,
	createTestKnowledgeEntry,
	createTestKnowledgeRelation,
	enableFeatures,
} from './factories';
import type { Doc } from '../_generated/dataModel';

/**
 * knowledge/edgeInference.ts — the LLM ("semantic") edge-inference pass, with the
 * LLM dispatch MOCKED to a fixed relations array. Verifies index→entryId mapping,
 * confidence→tag mapping, dedupe against pre-existing edges, spend recording, the
 * flag gate, error swallowing, and — the load-bearing one — that the candidate
 * pool is CONTACT-SCOPED so an inferred edge can never bridge contact A → contact B.
 *
 * Uses convex-test's in-memory vectorSearch (cosine over 1536-dim one-hot unit
 * vectors): cosine(unit(i), unit(j)) is 1 when i===j, so entries sharing an
 * embedding index are each other's nearest neighbors.
 */

// Hoisted so the vi.mock factory below can reference it.
const runLlmObjectMock = vi.hoisted(() => vi.fn());

// Stub the model resolver so the action needs no real LLM key, and the object
// dispatch so we feed it a deterministic relations array.
vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof import('../lib/llmProvider')>('../lib/llmProvider');
	return { ...actual, getLLMProvider: vi.fn(() => 'test-model') };
});

vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof import('../lib/llm/dispatch')>('../lib/llm/dispatch');
	return { ...actual, runLlmObject: runLlmObjectMock };
});

// AWS-SDK / heavy node-only modules aren't on the path under test; drop them.
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

interface MockRelation {
	from: number;
	to: number;
	relationType: string;
	confidence: number;
	rationale?: string;
}

function mockRelations(relations: MockRelation[]): void {
	runLlmObjectMock.mockResolvedValue({
		object: { relations },
		tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
		modelUsed: 'test-model',
	});
}

async function allRelations(
	t: ReturnType<typeof convexTest>,
): Promise<Doc<'knowledgeRelations'>[]> {
	return await t.run(async (ctx) => ctx.db.query('knowledgeRelations').collect());
}

beforeEach(() => {
	runLlmObjectMock.mockReset();
});

describe('knowledge.edgeInference.inferRelations', () => {
	it('maps LLM relation indices to entry ids and confidence to the right tag', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.autoLink']);

		const [a0, a1, a2] = await t.run(async (ctx) => {
			const x = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'A0', embedding: unit(5) }));
			const y = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'A1', embedding: unit(5) }));
			const z = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'A2', embedding: unit(5) }));
			return [x, y, z];
		});

		// Same embedding ⇒ the three anchors are each other's only neighbors, but an
		// anchor is never its own candidate, so the numbered list is exactly [a0,a1,a2].
		mockRelations([
			{ from: 0, to: 1, relationType: 'supersedes', confidence: 0.9 }, // >= floor → inferred
			{ from: 1, to: 2, relationType: 'contradicts', confidence: 0.5 }, // < floor → ambiguous
		]);

		await t.action(internal.knowledge.edgeInference.inferRelations, { entryIds: [a0, a1, a2] });

		const rels = await allRelations(t);
		expect(rels).toHaveLength(2);

		const e1 = rels.find((r) => r.fromEntryId === a0 && r.toEntryId === a1)!;
		expect(e1).toBeDefined();
		expect(e1.relationType).toBe('supersedes');
		expect(e1.provenance).toBe('llm');
		expect(e1.confidence).toBe(0.9);
		expect(e1.confidenceTag).toBe('inferred');
		expect(e1.weight).toBe(0.9); // weight = confidence

		const e2 = rels.find((r) => r.fromEntryId === a1 && r.toEntryId === a2)!;
		expect(e2).toBeDefined();
		expect(e2.relationType).toBe('contradicts');
		expect(e2.confidenceTag).toBe('ambiguous');
		expect(e2.weight).toBe(0.5);
	});

	it('records LLM spend under the knowledge_autolink feature', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.autoLink']);

		const [a0, a1] = await t.run(async (ctx) => {
			const x = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'A0', embedding: unit(5) }));
			const y = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'A1', embedding: unit(5) }));
			return [x, y];
		});

		mockRelations([{ from: 0, to: 1, relationType: 'supports', confidence: 0.8 }]);
		await t.action(internal.knowledge.edgeInference.inferRelations, { entryIds: [a0, a1] });

		const usage = await t.run(async (ctx) => ctx.db.query('llmUsageEvents').collect());
		expect(usage).toHaveLength(1);
		expect(usage[0]!.feature).toBe('knowledge_autolink');
		expect(usage[0]!.modelUsed).toBe('test-model');
	});

	it('does not write a second row for a pair that already has an edge', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.autoLink']);

		const [a0, a1] = await t.run(async (ctx) => {
			const x = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'A0', embedding: unit(5) }));
			const y = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'A1', embedding: unit(5) }));
			// A pre-existing deterministic edge for the same directed pair.
			await ctx.db.insert(
				'knowledgeRelations',
				createTestKnowledgeRelation({
					fromEntryId: x,
					toEntryId: y,
					relationType: 'relates_to',
					provenance: 'deterministic',
					confidenceTag: 'extracted',
					confidence: 1.0,
				}),
			);
			return [x, y];
		});

		mockRelations([{ from: 0, to: 1, relationType: 'supports', confidence: 0.9 }]);
		await t.action(internal.knowledge.edgeInference.inferRelations, { entryIds: [a0, a1] });

		const rels = await allRelations(t);
		expect(rels).toHaveLength(1); // pruned by existingEdgePairs — no second row
		expect(rels[0]!.relationType).toBe('relates_to');
		expect(rels[0]!.provenance).toBe('deterministic'); // untouched, not re-merged
	});

	it('is a no-op when ai.knowledge.autoLink is disabled', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge']); // autoLink stays off (its own flag, default off)

		const [a0, a1] = await t.run(async (ctx) => {
			const x = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'A0', embedding: unit(5) }));
			const y = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'A1', embedding: unit(5) }));
			return [x, y];
		});

		mockRelations([{ from: 0, to: 1, relationType: 'supports', confidence: 0.9 }]);
		await t.action(internal.knowledge.edgeInference.inferRelations, { entryIds: [a0, a1] });

		expect(runLlmObjectMock).not.toHaveBeenCalled();
		expect(await allRelations(t)).toHaveLength(0);
	});

	it('swallows LLM errors without writing edges or throwing', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.autoLink']);

		const [a0, a1] = await t.run(async (ctx) => {
			const x = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'A0', embedding: unit(5) }));
			const y = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ title: 'A1', embedding: unit(5) }));
			return [x, y];
		});

		runLlmObjectMock.mockRejectedValue(new Error('llm boom'));
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		// Resolves (does not reject) — the error is swallowed. Convex marshals the
		// handler's void return to null over the wire.
		await expect(
			t.action(internal.knowledge.edgeInference.inferRelations, { entryIds: [a0, a1] }),
		).resolves.toBeNull();
		expect(await allRelations(t)).toHaveLength(0);

		errSpy.mockRestore();
	});

	it('never links to another contact’s entry — the candidate pool is contact-scoped', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.autoLink']);

		const { anchor, legit, other } = await t.run(async (ctx) => {
			const contactA = await ctx.db.insert('contacts', createTestContact());
			const contactB = await ctx.db.insert('contacts', createTestContact());
			// Anchor is scoped to contact A; all three share embedding index 5 so a
			// vector search ALONE would surface every one of them.
			const anchor = await ctx.db.insert(
				'knowledgeEntries',
				createTestKnowledgeEntry({ title: 'anchorA', embedding: unit(5), contactIds: [contactA] }),
			);
			// Org-general entry — legitimately visible under contact A's scope.
			const legit = await ctx.db.insert(
				'knowledgeEntries',
				createTestKnowledgeEntry({ title: 'orgGeneral', embedding: unit(5) }),
			);
			// Contact B's private entry — MUST NOT be reachable from a contact-A anchor.
			const other = await ctx.db.insert(
				'knowledgeEntries',
				createTestKnowledgeEntry({ title: 'contactBsecret', embedding: unit(5), contactIds: [contactB] }),
			);
			return { anchor, legit, other };
		});

		// The model's second proposal points at an index that can only exist if the
		// other-contact entry had entered the (scoped) pool; it must be dropped.
		mockRelations([
			{ from: 0, to: 1, relationType: 'supports', confidence: 0.9 },
			{ from: 0, to: 2, relationType: 'contradicts', confidence: 0.9 },
		]);

		await t.action(internal.knowledge.edgeInference.inferRelations, { entryIds: [anchor] });

		const rels = await allRelations(t);
		// Hard isolation guarantee: no edge in either direction touches contact B's entry.
		for (const r of rels) {
			expect(r.fromEntryId).not.toBe(other);
			expect(r.toEntryId).not.toBe(other);
		}
		// And the legitimate, contact-visible neighbor WAS linked (the pool worked).
		expect(rels.some((r) => r.fromEntryId === anchor && r.toEntryId === legit)).toBe(true);
	});

	it('refuses a disjoint-contact edge even when both nodes are anchors in a mixed-scope batch', async () => {
		// Defense in depth for the per-edge contactScopesCanLink guard. The candidate
		// pool is contact-scoped, but anchors are added to the numbered list directly
		// (not through the scoped search), so a mixed-scope batch puts contact-A and
		// contact-B anchors side by side and the LLM can propose an edge between them.
		// Only the per-edge guard (mirroring linkStructural) can block that bridge.
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.autoLink']);

		const { anchorA, anchorB, shared } = await t.run(async (ctx) => {
			const contactA = await ctx.db.insert('contacts', createTestContact());
			const contactB = await ctx.db.insert('contacts', createTestContact());
			const anchorA = await ctx.db.insert(
				'knowledgeEntries',
				createTestKnowledgeEntry({ title: 'anchorA', embedding: unit(5), contactIds: [contactA] }),
			);
			const anchorB = await ctx.db.insert(
				'knowledgeEntries',
				createTestKnowledgeEntry({ title: 'anchorB', embedding: unit(5), contactIds: [contactB] }),
			);
			// Org-general entry: visible to BOTH contacts, so each anchor may link to it.
			const shared = await ctx.db.insert(
				'knowledgeEntries',
				createTestKnowledgeEntry({ title: 'orgGeneral', embedding: unit(5) }),
			);
			return { anchorA, anchorB, shared };
		});

		// Numbered list is [anchorA(0), anchorB(1), shared(2)]. The 0→1 proposal
		// bridges contact A → contact B and must be dropped; the org-general links pass.
		mockRelations([
			{ from: 0, to: 1, relationType: 'supports', confidence: 0.9 }, // A → B: BLOCKED
			{ from: 0, to: 2, relationType: 'supports', confidence: 0.9 }, // A → org-general: ok
			{ from: 1, to: 2, relationType: 'supports', confidence: 0.9 }, // B → org-general: ok
		]);

		await t.action(internal.knowledge.edgeInference.inferRelations, { entryIds: [anchorA, anchorB] });

		const rels = await allRelations(t);
		// No edge in either direction between the two disjoint-contact anchors.
		expect(
			rels.some(
				(r) =>
					(r.fromEntryId === anchorA && r.toEntryId === anchorB) ||
					(r.fromEntryId === anchorB && r.toEntryId === anchorA),
			),
		).toBe(false);
		// Both org-general links survive — the guard only blocks the disjoint pair.
		expect(rels.some((r) => r.fromEntryId === anchorA && r.toEntryId === shared)).toBe(true);
		expect(rels.some((r) => r.fromEntryId === anchorB && r.toEntryId === shared)).toBe(true);
	});
});
