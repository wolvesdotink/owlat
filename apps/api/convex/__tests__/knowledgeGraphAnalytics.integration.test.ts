import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import {
	createTestContact,
	createTestKnowledgeEntry,
	createTestKnowledgeRelation,
	enableFeatures,
} from './factories';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

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

const testUser = { subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' };

/** Insert an org-general knowledge entry, return its id. */
async function seedEntry(
	t: ReturnType<typeof convexTest>,
	overrides: Record<string, unknown> = {},
): Promise<Id<'knowledgeEntries'>> {
	let id!: Id<'knowledgeEntries'>;
	await t.run(async (ctx) => {
		id = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry(overrides));
	});
	return id;
}

async function seedEdge(
	t: ReturnType<typeof convexTest>,
	from: Id<'knowledgeEntries'>,
	to: Id<'knowledgeEntries'>,
	relationType = 'relates_to' as const,
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'knowledgeRelations',
			createTestKnowledgeRelation({ fromEntryId: from, toEntryId: to, relationType }),
		);
	});
}

// ============ recomputeStats — god nodes ============

describe('knowledgeGraphAnalytics.recomputeStats god nodes', () => {
	it('ranks the highest-degree hub first', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.analytics']);
		const asUser = t.withIdentity(testUser);

		const hub = await seedEntry(t, { title: 'Hub' });
		const leaves: Id<'knowledgeEntries'>[] = [];
		for (let i = 0; i < 5; i++) leaves.push(await seedEntry(t, { title: `Leaf ${i}` }));
		for (const leaf of leaves) await seedEdge(t, hub, leaf);
		// One extra edge between two leaves so a leaf has degree 2 (still < hub's 5).
		await seedEdge(t, leaves[0]!, leaves[1]!);

		await t.action(internal.knowledge.graphAnalyticsRecompute.recomputeStats, {});

		const stats = await asUser.query(api.knowledge.graphAnalytics.getGraphStats, {});
		expect(stats).not.toBeNull();
		expect(stats!.nodeCount).toBe(6);
		expect(stats!.edgeCount).toBe(6);
		// Hub is the top god node with degree 5 (all outgoing).
		expect(stats!.godNodes[0]!.entryId).toBe(hub);
		expect(stats!.godNodes[0]!.degree).toBe(5);
		expect(stats!.godNodes[0]!.outDegree).toBe(5);
		expect(stats!.godNodes[0]!.inDegree).toBe(0);
	});
});

// ============ recomputeStats — confidence buckets ============

describe('knowledgeGraphAnalytics.recomputeStats confidence', () => {
	it('confidence buckets sum to nodeCount and report below-threshold', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.analytics']);
		const asUser = t.withIdentity(testUser);

		const confidences = [0.05, 0.2, 0.25, 0.55, 0.8, 0.95, 1.0];
		for (const c of confidences) await seedEntry(t, { confidence: c });

		await t.action(internal.knowledge.graphAnalyticsRecompute.recomputeStats, {});

		const stats = await asUser.query(api.knowledge.graphAnalytics.getGraphStats, {});
		expect(stats).not.toBeNull();
		expect(stats!.confidenceBuckets).toHaveLength(10);
		const sum = stats!.confidenceBuckets.reduce((a, b) => a + b, 0);
		expect(sum).toBe(stats!.nodeCount);
		expect(sum).toBe(confidences.length);
		// REVIEW_THRESHOLD is 0.3 → three of these (0.05, 0.2, 0.25) are below it.
		expect(stats!.belowReviewThreshold).toBe(3);
	});
});

// ============ recomputeStats — community stability ============

describe('knowledgeGraphAnalytics.recomputeStats communities', () => {
	it('label-propagation community count is stable across runs', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.analytics']);
		const asUser = t.withIdentity(testUser);

		// Two triangles (dense clusters) joined by a single bridge edge.
		const a = [await seedEntry(t, { title: 'a0' }), await seedEntry(t, { title: 'a1' }), await seedEntry(t, { title: 'a2' })];
		const b = [await seedEntry(t, { title: 'b0' }), await seedEntry(t, { title: 'b1' }), await seedEntry(t, { title: 'b2' })];
		await seedEdge(t, a[0]!, a[1]!);
		await seedEdge(t, a[1]!, a[2]!);
		await seedEdge(t, a[2]!, a[0]!);
		await seedEdge(t, b[0]!, b[1]!);
		await seedEdge(t, b[1]!, b[2]!);
		await seedEdge(t, b[2]!, b[0]!);
		await seedEdge(t, a[0]!, b[0]!); // bridge

		await t.action(internal.knowledge.graphAnalyticsRecompute.recomputeStats, {});
		const first = await asUser.query(api.knowledge.graphAnalytics.getGraphStats, {});
		await t.action(internal.knowledge.graphAnalyticsRecompute.recomputeStats, {});
		const second = await asUser.query(api.knowledge.graphAnalytics.getGraphStats, {});

		expect(first!.communityCount).toBe(second!.communityCount);
		expect(first!.communitySizes).toEqual(second!.communitySizes);
		// Every node landed in some community; sizes sum to the node count.
		expect(first!.communitySizes.reduce((x, y) => x + y, 0)).toBe(first!.nodeCount);
	});
});

// ============ recomputeStats — truncation ============

describe('knowledgeGraphAnalytics.recomputeStats truncation', () => {
	it('isTruncated flips when the node cap is exceeded', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.analytics']);
		const asUser = t.withIdentity(testUser);

		for (let i = 0; i < 3; i++) await seedEntry(t, { title: `n${i}` });

		// Cap below the row count → truncated.
		await t.action(internal.knowledge.graphAnalyticsRecompute.recomputeStats, { maxNodes: 2 });
		let stats = await asUser.query(api.knowledge.graphAnalytics.getGraphStats, {});
		expect(stats!.isTruncated).toBe(true);
		expect(stats!.nodeCount).toBe(2);

		// Generous cap → not truncated, full count.
		await t.action(internal.knowledge.graphAnalyticsRecompute.recomputeStats, {});
		stats = await asUser.query(api.knowledge.graphAnalytics.getGraphStats, {});
		expect(stats!.isTruncated).toBe(false);
		expect(stats!.nodeCount).toBe(3);
	});
});

// ============ recomputeStats — REDACTION ============

describe('knowledgeGraphAnalytics.recomputeStats redaction', () => {
	it('excludes cross-contact-disjoint edges from surprisingConnections, counts them in aggregate, and gates detail behind admin', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.analytics']);
		const asUser = t.withIdentity(testUser);

		let contactA!: Id<'contacts'>;
		let contactB!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactA = await ctx.db.insert('contacts', createTestContact());
			contactB = await ctx.db.insert('contacts', createTestContact());
		});

		const entryA = await seedEntry(t, { title: 'A-only', contactIds: [contactA] });
		const entryB = await seedEntry(t, { title: 'B-only', contactIds: [contactB] });
		const entryG = await seedEntry(t, { title: 'Org general' });

		await seedEdge(t, entryA, entryB); // cross-contact-disjoint → REDACTED
		await seedEdge(t, entryA, entryG); // member-visible (G is org-general)

		await t.action(internal.knowledge.graphAnalyticsRecompute.recomputeStats, {});

		const stats = await asUser.query(api.knowledge.graphAnalytics.getGraphStats, {});
		expect(stats).not.toBeNull();
		// The aggregate counts the one disjoint edge.
		expect(stats!.crossContactLinkCount).toBe(1);
		// No surprising connection is the A↔B disjoint pair (either direction).
		for (const c of stats!.surprisingConnections) {
			const isDisjointPair =
				(c.fromEntryId === entryA && c.toEntryId === entryB) ||
				(c.fromEntryId === entryB && c.toEntryId === entryA);
			expect(isDisjointPair).toBe(false);
		}
		// The member read strips the admin-only cross-contact detail entirely.
		expect(stats).not.toHaveProperty('crossContactLinks');

		// The admin detail query DOES surface the disjoint edge's endpoints.
		const adminLinks = await asUser.query(api.knowledge.graphAnalytics.getCrossContactLinks, {});
		expect(adminLinks).toHaveLength(1);
		expect(adminLinks[0]!.fromEntryId).toBe(entryA);
		expect(adminLinks[0]!.toEntryId).toBe(entryB);
	});
});

// ============ getGraphStats / getSubgraph — soft-auth ============

describe('knowledgeGraphAnalytics soft-auth', () => {
	it('getGraphStats returns null for a non-member', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.analytics']);
		await seedEntry(t, { title: 'hidden' });
		await t.action(internal.knowledge.graphAnalyticsRecompute.recomputeStats, {});

		const { isActiveOrgMember } = await import('../lib/sessionOrganization');
		vi.mocked(isActiveOrgMember).mockResolvedValueOnce(false);

		const stats = await t.query(api.knowledge.graphAnalytics.getGraphStats, {});
		expect(stats).toBeNull();
	});

	it('getSubgraph returns empty for a non-member', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.analytics']);
		const root = await seedEntry(t, { title: 'root' });
		const neighbour = await seedEntry(t, { title: 'neighbour' });
		await seedEdge(t, root, neighbour);

		const { isActiveOrgMember } = await import('../lib/sessionOrganization');
		vi.mocked(isActiveOrgMember).mockResolvedValueOnce(false);

		const sub = await t.query(api.knowledge.graphAnalytics.getSubgraph, { entryId: root });
		expect(sub.nodes).toEqual([]);
		expect(sub.edges).toEqual([]);
	});

	it('getGraphStats returns null when the analytics flag is off (kill switch)', async () => {
		const t = convexTest(schema, modules);
		// ai.knowledge enabled but NOT ai.knowledge.analytics.
		await enableFeatures(t, ['ai.knowledge']);
		const asUser = t.withIdentity(testUser);
		await seedEntry(t, { title: 'x' });

		const stats = await asUser.query(api.knowledge.graphAnalytics.getGraphStats, {});
		expect(stats).toBeNull();
	});
});

// ============ getSubgraph — bounded BFS ============

describe('knowledgeGraphAnalytics.getSubgraph', () => {
	it('returns a bounded subgraph (nodes + edges) around an entry for a member', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.analytics']);
		const asUser = t.withIdentity(testUser);

		const root = await seedEntry(t, { title: 'root' });
		const n1 = await seedEntry(t, { title: 'n1' });
		const n2 = await seedEntry(t, { title: 'n2' });
		await seedEdge(t, root, n1);
		await seedEdge(t, n1, n2); // 2 hops away

		const oneHop = await asUser.query(api.knowledge.graphAnalytics.getSubgraph, {
			entryId: root,
			depth: 1,
		});
		expect(oneHop.nodes.map((n) => n.id).sort()).toEqual([root, n1].sort());

		const twoHop = await asUser.query(api.knowledge.graphAnalytics.getSubgraph, {
			entryId: root,
			depth: 2,
		});
		expect(twoHop.nodes.map((n) => n.id).sort()).toEqual([root, n1, n2].sort());
		// Every recorded edge has both endpoints present in the node set.
		const nodeIds = new Set(twoHop.nodes.map((n) => n.id as string));
		for (const e of twoHop.edges) {
			expect(nodeIds.has(e.fromId as string)).toBe(true);
			expect(nodeIds.has(e.toId as string)).toBe(true);
		}
	});

	it('surfaces each edge confidenceTag so the dashboard can style edges', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.knowledge.analytics']);
		const asUser = t.withIdentity(testUser);

		const root = await seedEntry(t, { title: 'root' });
		const inferred = await seedEntry(t, { title: 'inferred-neighbour' });
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'knowledgeRelations',
				createTestKnowledgeRelation({
					fromEntryId: root,
					toEntryId: inferred,
					relationType: 'relates_to',
					confidenceTag: 'inferred',
					provenance: 'llm',
					confidence: 0.6,
				}),
			);
		});

		const sub = await asUser.query(api.knowledge.graphAnalytics.getSubgraph, {
			entryId: root,
			depth: 1,
		});
		expect(sub.edges).toHaveLength(1);
		expect(sub.edges[0]!.confidenceTag).toBe('inferred');
	});
});
