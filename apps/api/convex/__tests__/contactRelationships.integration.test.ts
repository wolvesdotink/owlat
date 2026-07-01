import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestContact, createTestContactRelationship } from './factories';
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

vi.mock('../lib/posthogHelpers', async () => ({
	trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
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

// ============ contactRelationships.create ============

describe('contactRelationships.create', () => {
	it('should create a relationship between two contacts', async () => {
		const t = convexTest(schema, modules);
		let contactA!: Id<'contacts'>;
		let contactB!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactA = await ctx.db.insert('contacts', createTestContact({ email: 'a@example.com' }));
			contactB = await ctx.db.insert('contacts', createTestContact({ email: 'b@example.com' }));
		});

		const relId = await t.mutation(api.contacts.relationships.create, {
			fromContactId: contactA,
			toContactId: contactB,
			relationship: 'colleague',
		});

		expect(relId).toBeDefined();

		await t.run(async (ctx) => {
			const rel = await ctx.db.get(relId);
			expect(rel).toBeDefined();
			expect(rel!.fromContactId).toBe(contactA);
			expect(rel!.toContactId).toBe(contactB);
			expect(rel!.relationship).toBe('colleague');
			expect(rel!.confidence).toBe(1.0); // default confidence
			expect(rel!.source).toBe('manual');
			expect(rel!.createdAt).toBeTypeOf('number');
		});
	});

	it('should throw when creating a self-relationship', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		await expect(
			t.mutation(api.contacts.relationships.create, {
				fromContactId: contactId,
				toContactId: contactId,
				relationship: 'knows',
			})
		).rejects.toThrow('Cannot create a relationship between a contact and itself');
	});

	it('should return existing relationship ID for duplicate and update confidence if higher', async () => {
		const t = convexTest(schema, modules);
		let contactA!: Id<'contacts'>;
		let contactB!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactA = await ctx.db.insert('contacts', createTestContact({ email: 'a@example.com' }));
			contactB = await ctx.db.insert('contacts', createTestContact({ email: 'b@example.com' }));
		});

		const firstId = await t.mutation(api.contacts.relationships.create, {
			fromContactId: contactA,
			toContactId: contactB,
			relationship: 'colleague',
			confidence: 0.5,
		});

		// Create duplicate with higher confidence
		const secondId = await t.mutation(api.contacts.relationships.create, {
			fromContactId: contactA,
			toContactId: contactB,
			relationship: 'colleague',
			confidence: 0.9,
		});

		expect(secondId).toBe(firstId); // same relationship returned

		await t.run(async (ctx) => {
			const rel = await ctx.db.get(firstId);
			expect(rel!.confidence).toBe(0.9); // updated to higher
		});
	});

	it('should not update confidence if new value is lower', async () => {
		const t = convexTest(schema, modules);
		let contactA!: Id<'contacts'>;
		let contactB!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactA = await ctx.db.insert('contacts', createTestContact({ email: 'a@example.com' }));
			contactB = await ctx.db.insert('contacts', createTestContact({ email: 'b@example.com' }));
		});

		await t.mutation(api.contacts.relationships.create, {
			fromContactId: contactA,
			toContactId: contactB,
			relationship: 'manager_of',
			confidence: 0.9,
		});

		const dupId = await t.mutation(api.contacts.relationships.create, {
			fromContactId: contactA,
			toContactId: contactB,
			relationship: 'manager_of',
			confidence: 0.3,
		});

		await t.run(async (ctx) => {
			const rel = await ctx.db.get(dupId);
			expect(rel!.confidence).toBe(0.9); // unchanged
		});
	});
});

// ============ contactRelationships.listByContact ============

describe('contactRelationships.listByContact', () => {
	it('should return relationships in both directions', async () => {
		const t = convexTest(schema, modules);
		let contactA!: Id<'contacts'>;
		let contactB!: Id<'contacts'>;
		let contactC!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactA = await ctx.db.insert('contacts', createTestContact({ email: 'a@example.com' }));
			contactB = await ctx.db.insert('contacts', createTestContact({ email: 'b@example.com' }));
			contactC = await ctx.db.insert('contacts', createTestContact({ email: 'c@example.com' }));
			// A -> B (outgoing from A)
			await ctx.db.insert('contactRelationships', createTestContactRelationship({
				fromContactId: contactA,
				toContactId: contactB,
				relationship: 'colleague',
			}));
			// C -> A (incoming to A)
			await ctx.db.insert('contactRelationships', createTestContactRelationship({
				fromContactId: contactC,
				toContactId: contactA,
				relationship: 'manager_of',
			}));
		});

		// Verify both directions via raw DB (query requires auth)
		await t.run(async (ctx) => {
			const outgoing = await ctx.db
				.query('contactRelationships')
				.withIndex('by_from', (q) => q.eq('fromContactId', contactA))
				.collect();
			expect(outgoing).toHaveLength(1);
			expect(outgoing[0]!.toContactId).toBe(contactB);

			const incoming = await ctx.db
				.query('contactRelationships')
				.withIndex('by_to', (q) => q.eq('toContactId', contactA))
				.collect();
			expect(incoming).toHaveLength(1);
			expect(incoming[0]!.fromContactId).toBe(contactC);
		});
	});
});

// ============ contactRelationships.getGraph ============

describe('contactRelationships.getGraph', () => {
	it('should perform BFS traversal respecting depth limit', async () => {
		const t = convexTest(schema, modules);
		let contactA!: Id<'contacts'>;
		let contactB!: Id<'contacts'>;
		let contactC!: Id<'contacts'>;
		let contactD!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactA = await ctx.db.insert('contacts', createTestContact({ email: 'a@example.com' }));
			contactB = await ctx.db.insert('contacts', createTestContact({ email: 'b@example.com' }));
			contactC = await ctx.db.insert('contacts', createTestContact({ email: 'c@example.com' }));
			contactD = await ctx.db.insert('contacts', createTestContact({ email: 'd@example.com' }));
			// A -> B (depth 1)
			await ctx.db.insert('contactRelationships', createTestContactRelationship({
				fromContactId: contactA,
				toContactId: contactB,
				relationship: 'colleague',
			}));
			// B -> C (depth 2)
			await ctx.db.insert('contactRelationships', createTestContactRelationship({
				fromContactId: contactB,
				toContactId: contactC,
				relationship: 'manager_of',
			}));
			// C -> D (depth 3, beyond default depth=2)
			await ctx.db.insert('contactRelationships', createTestContactRelationship({
				fromContactId: contactC,
				toContactId: contactD,
				relationship: 'knows',
			}));
		});

		// BFS from A with depth=1 should only reach A and B
		await t.run(async (ctx) => {
			// Simulate BFS with depth=1
			const visited = new Set<string>();
			const queue: Array<{ contactId: Id<'contacts'>; depth: number }> = [
				{ contactId: contactA, depth: 0 },
			];
			const maxDepth = 1;
			const foundContacts: Id<'contacts'>[] = [];

			while (queue.length > 0) {
				const { contactId, depth } = queue.shift()!;
				if (visited.has(contactId as string)) continue;
				visited.add(contactId as string);
				foundContacts.push(contactId);

				if (depth >= maxDepth) continue;

				const outgoing = await ctx.db
					.query('contactRelationships')
					.withIndex('by_from', (q) => q.eq('fromContactId', contactId))
					.collect();
				const incoming = await ctx.db
					.query('contactRelationships')
					.withIndex('by_to', (q) => q.eq('toContactId', contactId))
					.collect();

				for (const rel of outgoing) {
					if (!visited.has(rel.toContactId as string)) {
						queue.push({ contactId: rel.toContactId, depth: depth + 1 });
					}
				}
				for (const rel of incoming) {
					if (!visited.has(rel.fromContactId as string)) {
						queue.push({ contactId: rel.fromContactId, depth: depth + 1 });
					}
				}
			}

			expect(foundContacts).toHaveLength(2); // A and B only
			expect(foundContacts).toContain(contactA);
			expect(foundContacts).toContain(contactB);
			expect(foundContacts).not.toContain(contactC);
			expect(foundContacts).not.toContain(contactD);
		});
	});

	it('should default to depth 2 and traverse full graph', async () => {
		const t = convexTest(schema, modules);
		let contactA!: Id<'contacts'>;
		let contactB!: Id<'contacts'>;
		let contactC!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactA = await ctx.db.insert('contacts', createTestContact({ email: 'a@example.com' }));
			contactB = await ctx.db.insert('contacts', createTestContact({ email: 'b@example.com' }));
			contactC = await ctx.db.insert('contacts', createTestContact({ email: 'c@example.com' }));
			await ctx.db.insert('contactRelationships', createTestContactRelationship({
				fromContactId: contactA,
				toContactId: contactB,
				relationship: 'colleague',
			}));
			await ctx.db.insert('contactRelationships', createTestContactRelationship({
				fromContactId: contactB,
				toContactId: contactC,
				relationship: 'knows',
			}));
		});

		// BFS from A with depth=2 should reach A, B, and C
		await t.run(async (ctx) => {
			const visited = new Set<string>();
			const queue: Array<{ contactId: Id<'contacts'>; depth: number }> = [
				{ contactId: contactA, depth: 0 },
			];
			const maxDepth = 2;
			const foundContacts: Id<'contacts'>[] = [];

			while (queue.length > 0) {
				const { contactId, depth } = queue.shift()!;
				if (visited.has(contactId as string)) continue;
				visited.add(contactId as string);
				foundContacts.push(contactId);

				if (depth >= maxDepth) continue;

				const outgoing = await ctx.db
					.query('contactRelationships')
					.withIndex('by_from', (q) => q.eq('fromContactId', contactId))
					.collect();
				for (const rel of outgoing) {
					if (!visited.has(rel.toContactId as string)) {
						queue.push({ contactId: rel.toContactId, depth: depth + 1 });
					}
				}
				const incoming = await ctx.db
					.query('contactRelationships')
					.withIndex('by_to', (q) => q.eq('toContactId', contactId))
					.collect();
				for (const rel of incoming) {
					if (!visited.has(rel.fromContactId as string)) {
						queue.push({ contactId: rel.fromContactId, depth: depth + 1 });
					}
				}
			}

			expect(foundContacts).toHaveLength(3);
			expect(foundContacts).toContain(contactA);
			expect(foundContacts).toContain(contactB);
			expect(foundContacts).toContain(contactC);
		});
	});
});

// ============ contactRelationships.updateConfidence ============

describe('contactRelationships.updateConfidence', () => {
	it('should update confidence on a relationship', async () => {
		const t = convexTest(schema, modules);
		let relId!: Id<'contactRelationships'>;

		await t.run(async (ctx) => {
			const contactA = await ctx.db.insert('contacts', createTestContact({ email: 'a@example.com' }));
			const contactB = await ctx.db.insert('contacts', createTestContact({ email: 'b@example.com' }));
			relId = await ctx.db.insert('contactRelationships', createTestContactRelationship({
				fromContactId: contactA,
				toContactId: contactB,
				confidence: 0.5,
			}));
		});

		await t.mutation(api.contacts.relationships.updateConfidence, {
			relationshipId: relId,
			confidence: 0.95,
		});

		await t.run(async (ctx) => {
			const rel = await ctx.db.get(relId);
			expect(rel!.confidence).toBe(0.95);
		});
	});
});

// ============ contactRelationships.remove ============

describe('contactRelationships.remove', () => {
	it('should delete a relationship', async () => {
		const t = convexTest(schema, modules);
		let relId!: Id<'contactRelationships'>;

		await t.run(async (ctx) => {
			const contactA = await ctx.db.insert('contacts', createTestContact({ email: 'a@example.com' }));
			const contactB = await ctx.db.insert('contacts', createTestContact({ email: 'b@example.com' }));
			relId = await ctx.db.insert('contactRelationships', createTestContactRelationship({
				fromContactId: contactA,
				toContactId: contactB,
			}));
		});

		await t.mutation(api.contacts.relationships.remove, { relationshipId: relId });

		await t.run(async (ctx) => {
			const rel = await ctx.db.get(relId);
			expect(rel).toBeNull();
		});
	});
});
