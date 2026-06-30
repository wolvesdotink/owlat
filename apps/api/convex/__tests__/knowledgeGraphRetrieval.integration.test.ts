import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

/**
 * Graph-augmented retrieval — the per-hop contact-scope gate (leak surface #1)
 * in knowledge/graphTraversal.ts, and the seed-then-expand annotations
 * (_via/_caveat/_stale) + kill switch in knowledge/retrieval.ts:semanticSearch.
 *
 * Uses convex-test's in-memory vectorSearch (cosine). 1536-dim one-hot vectors
 * give cosine 1 for the same index and 0 otherwise, so we place entries exactly
 * "near" or "far" from a query embedding.
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
	contactIds?: Id<'contacts'>[];
	expiresAt?: number;
	entryType?: 'fact' | 'decision' | 'preference';
	embedAt?: number;
};

async function insertEntry(
	t: ReturnType<typeof convexTest>,
	spec: EntrySpec,
): Promise<Id<'knowledgeEntries'>> {
	const now = Date.now();
	return await t.run(async (ctx) =>
		ctx.db.insert('knowledgeEntries', {
			entryType: spec.entryType ?? 'fact',
			title: spec.title,
			content: spec.title,
			sourceType: 'email',
			contactIds: spec.contactIds,
			embedding: spec.embedAt === undefined ? [] : unit(spec.embedAt),
			confidence: 0.9,
			lastValidatedAt: now,
			expiresAt: spec.expiresAt,
			searchableText: spec.title,
			createdAt: now,
			updatedAt: now,
		}),
	);
}

async function relate(
	t: ReturnType<typeof convexTest>,
	from: Id<'knowledgeEntries'>,
	to: Id<'knowledgeEntries'>,
	relationType: 'relates_to' | 'supports' | 'supersedes' | 'contradicts',
): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert('knowledgeRelations', {
			fromEntryId: from,
			toEntryId: to,
			relationType,
			confidenceTag: 'extracted',
			confidence: 1.0,
			provenance: 'manual',
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe('graphTraversal.expandNeighbors — per-hop contact-scope gate', () => {
	/** Org-general seed S edged to a contact-A node, a contact-B node, and an org-general node. */
	async function setup() {
		const t = convexTest(schema, modules);
		const { contactA, contactB } = await t.run(async (ctx) => {
			const contactA = await ctx.db.insert('contacts', {
				email: 'a@example.com',
				source: 'api' as const,
				doiStatus: 'not_required' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			const contactB = await ctx.db.insert('contacts', {
				email: 'b@example.com',
				source: 'api' as const,
				doiStatus: 'not_required' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			return { contactA, contactB };
		});
		const seedId = await insertEntry(t, { title: 'seed (org-general)' });
		const naId = await insertEntry(t, { title: 'contact-A node', contactIds: [contactA] });
		const nbId = await insertEntry(t, { title: 'contact-B node', contactIds: [contactB] });
		const ncId = await insertEntry(t, { title: 'other org-general node' });
		await relate(t, seedId, naId, 'relates_to');
		await relate(t, seedId, nbId, 'relates_to');
		await relate(t, seedId, ncId, 'relates_to');
		return { t, contactA, contactB, seedId, naId, nbId, ncId };
	}

	it('scope:contactA drops the contact-B-only neighbour from BOTH neighbours and edges', async () => {
		const { t, contactA, seedId, naId, nbId, ncId } = await setup();

		const res = await t.query(internal.knowledge.graphTraversal.expandNeighbors, {
			seedIds: [seedId],
			scope: contactA,
			hops: 1,
			neighborBudget: 32,
		});

		const ids = res.neighbors.map((n) => n.id);
		expect(ids).toContain(naId); // contact-A node visible to a contact-A draft
		expect(ids).toContain(ncId); // org-general node always visible
		expect(ids).not.toContain(nbId); // contact-B node hidden

		// And no edge betrays its existence either.
		const edgeIds = res.edges.flatMap((e) => [e.fromId, e.toId]);
		expect(edgeIds).not.toContain(nbId);
	});

	it("scope:'org-general-only' drops BOTH contact-specific neighbours", async () => {
		const { t, seedId, naId, nbId, ncId } = await setup();

		const res = await t.query(internal.knowledge.graphTraversal.expandNeighbors, {
			seedIds: [seedId],
			scope: 'org-general-only',
			hops: 1,
			neighborBudget: 32,
		});

		const ids = res.neighbors.map((n) => n.id);
		expect(ids).toContain(ncId);
		expect(ids).not.toContain(naId);
		expect(ids).not.toContain(nbId);
	});

	it("scope:'org-wide' keeps the contact-B-only neighbour", async () => {
		const { t, seedId, naId, nbId, ncId } = await setup();

		const res = await t.query(internal.knowledge.graphTraversal.expandNeighbors, {
			seedIds: [seedId],
			scope: 'org-wide',
			hops: 1,
			neighborBudget: 32,
		});

		const ids = res.neighbors.map((n) => n.id);
		expect(ids).toContain(naId);
		expect(ids).toContain(nbId);
		expect(ids).toContain(ncId);
	});

	it('2-hop containment: an invisible node cannot pull its own org-general neighbour into reach', async () => {
		const t = convexTest(schema, modules);
		const contactA = await t.run(async (ctx) =>
			ctx.db.insert('contacts', {
				email: 'a@example.com',
				source: 'api' as const,
				doiStatus: 'not_required' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const contactB = await t.run(async (ctx) =>
			ctx.db.insert('contacts', {
				email: 'b@example.com',
				source: 'api' as const,
				doiStatus: 'not_required' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const seedId = await insertEntry(t, { title: 'seed' });
		const nbId = await insertEntry(t, { title: 'contact-B hop-1', contactIds: [contactB] });
		const ncId = await insertEntry(t, { title: 'org-general hop-2 behind B' });
		await relate(t, seedId, nbId, 'relates_to'); // hop 1 (blocked for contactA)
		await relate(t, nbId, ncId, 'relates_to'); // hop 2 (only reachable through B)

		const res = await t.query(internal.knowledge.graphTraversal.expandNeighbors, {
			seedIds: [seedId],
			scope: contactA,
			hops: 2,
			neighborBudget: 32,
		});

		const ids = res.neighbors.map((n) => n.id);
		expect(ids).not.toContain(nbId); // blocked at hop 1
		expect(ids).not.toContain(ncId); // never reached — B is not a frontier
	});

	it('drops a neighbour whose TTL has lapsed', async () => {
		const t = convexTest(schema, modules);
		const seedId = await insertEntry(t, { title: 'seed' });
		const expiredId = await insertEntry(t, {
			title: 'expired neighbour',
			expiresAt: Date.now() - 1000,
		});
		await relate(t, seedId, expiredId, 'relates_to');

		const res = await t.query(internal.knowledge.graphTraversal.expandNeighbors, {
			seedIds: [seedId],
			scope: 'org-wide',
			hops: 1,
			neighborBudget: 32,
		});

		expect(res.neighbors.map((n) => n.id)).not.toContain(expiredId);
	});

	it('honours the entryType filter', async () => {
		const t = convexTest(schema, modules);
		const seedId = await insertEntry(t, { title: 'seed' });
		const factId = await insertEntry(t, { title: 'a fact', entryType: 'fact' });
		const prefId = await insertEntry(t, { title: 'a preference', entryType: 'preference' });
		await relate(t, seedId, factId, 'relates_to');
		await relate(t, seedId, prefId, 'relates_to');

		const res = await t.query(internal.knowledge.graphTraversal.expandNeighbors, {
			seedIds: [seedId],
			scope: 'org-wide',
			hops: 1,
			neighborBudget: 32,
			entryType: 'fact',
		});

		const ids = res.neighbors.map((n) => n.id);
		expect(ids).toContain(factId);
		expect(ids).not.toContain(prefId);
	});
});

describe('semanticSearch — graph-augmented annotations + kill switch', () => {
	it('marks the target of a supersedes edge _stale and attaches _via', async () => {
		const t = convexTest(schema, modules);
		// Both newer + older are vector hits at the same index.
		const newer = await insertEntry(t, { title: 'Acme moved to AWS', embedAt: 4 });
		const older = await insertEntry(t, { title: 'Acme uses on-prem', embedAt: 4 });
		await relate(t, newer, older, 'supersedes'); // newer SUPERSEDES older

		const results = await t.action(internal.knowledge.retrieval.semanticSearch, {
			embedding: unit(4),
			scopeToContact: 'org-wide',
			limit: 10,
			expandGraph: true,
		});

		const byId = new Map(results.map((r) => [r._id, r]));
		expect(byId.get(older)?._stale).toBe(true);
		expect(byId.get(newer)?._stale ?? false).toBe(false);

		const via = byId.get(newer)?._via ?? [];
		expect(via.some((v) => v.relation === 'supersedes' && v.direction === 'outgoing')).toBe(true);

		// Demoted: the newer (superseding) fact ranks above the stale one.
		expect(results.findIndex((r) => r._id === newer)).toBeLessThan(
			results.findIndex((r) => r._id === older),
		);
	});

	it('flags both endpoints of a contradicts edge with _caveat and keeps them', async () => {
		const t = convexTest(schema, modules);
		const a = await insertEntry(t, { title: 'Ship date is March', embedAt: 6 });
		const b = await insertEntry(t, { title: 'Ship date is May', embedAt: 6 });
		await relate(t, a, b, 'contradicts');

		const results = await t.action(internal.knowledge.retrieval.semanticSearch, {
			embedding: unit(6),
			scopeToContact: 'org-wide',
			limit: 10,
			expandGraph: true,
		});

		const byId = new Map(results.map((r) => [r._id, r]));
		expect(byId.get(a)?._caveat).toBe(true);
		expect(byId.get(b)?._caveat).toBe(true);
	});

	it('KILL SWITCH: expandGraph:false is identical to the flat (no-arg) run', async () => {
		const t = convexTest(schema, modules);
		const a = await insertEntry(t, { title: 'newer fact', embedAt: 5 });
		const b = await insertEntry(t, { title: 'older fact', embedAt: 5 });
		await relate(t, a, b, 'supersedes');

		const flat = await t.action(internal.knowledge.retrieval.semanticSearch, {
			embedding: unit(5),
			scopeToContact: 'org-wide',
			limit: 10,
		});
		const off = await t.action(internal.knowledge.retrieval.semanticSearch, {
			embedding: unit(5),
			scopeToContact: 'org-wide',
			limit: 10,
			expandGraph: false,
		});

		expect(off).toEqual(flat);
		// No graph annotations on the flat path.
		expect(off.some((r) => r._stale || r._caveat || r._via)).toBe(false);
	});
});
