import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { createTestContact, createTestKnowledgeEntry } from './factories';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
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

const testUser = { subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' };

// ============ knowledgeGraph.createEntry ============

describe('knowledgeGraph.createEntry', () => {
	it('should create an entry with correct fields', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		const entryId = await asUser.mutation(api.knowledge.graph.createEntry, {
			entryType: 'fact',
			title: 'Test Fact',
			content: 'This is a test fact about the project.',
			sourceType: 'manual',
		});

		expect(entryId).toBeDefined();

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(entryId);
			expect(entry).toBeDefined();
			expect(entry!.entryType).toBe('fact');
			expect(entry!.title).toBe('Test Fact');
			expect(entry!.content).toBe('This is a test fact about the project.');
			expect(entry!.sourceType).toBe('manual');
			expect(entry!.searchableText).toBe('Test Fact This is a test fact about the project.');
			expect(entry!.embedding).toEqual([]);
			expect(entry!.createdAt).toBeTypeOf('number');
			expect(entry!.updatedAt).toBeTypeOf('number');
			expect(entry!.lastValidatedAt).toBeTypeOf('number');
		});
	});

	it('should default confidence to 0.8', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		const entryId = await asUser.mutation(api.knowledge.graph.createEntry, {
			entryType: 'decision',
			title: 'Default Confidence',
			content: 'Entry without explicit confidence.',
			sourceType: 'email',
		});

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(entryId);
			expect(entry!.confidence).toBe(0.8);
		});
	});

	it('should use provided confidence when specified', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		const entryId = await asUser.mutation(api.knowledge.graph.createEntry, {
			entryType: 'preference',
			title: 'Custom Confidence',
			content: 'Entry with explicit confidence.',
			sourceType: 'chat',
			confidence: 0.95,
		});

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(entryId);
			expect(entry!.confidence).toBe(0.95);
		});
	});

	it('should store optional fields (tags, expiresAt, contactIds, sourceId)', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		let contactId!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const expiresAt = Date.now() + 86400000;
		const entryId = await asUser.mutation(api.knowledge.graph.createEntry, {
			entryType: 'event',
			title: 'Tagged Event',
			content: 'An event with all optional fields.',
			sourceType: 'agent_extracted',
			sourceId: 'msg-123',
			contactIds: [contactId],
			tags: ['important', 'project-x'],
			expiresAt,
		});

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(entryId);
			expect(entry!.sourceId).toBe('msg-123');
			expect(entry!.contactIds).toEqual([contactId]);
			expect(entry!.tags).toEqual(['important', 'project-x']);
			expect(entry!.expiresAt).toBe(expiresAt);
		});
	});
});

// ============ knowledgeGraph.updateEntry ============

describe('knowledgeGraph.updateEntry', () => {
	it('edits user-authored fields and recomputes searchableText', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		const entryId = await asUser.mutation(api.knowledge.graph.createEntry, {
			entryType: 'fact',
			title: 'Typo Titlle',
			content: 'Wrong content.',
			sourceType: 'manual',
			confidence: 0.8,
		});

		// Returns the edited id (a non-undefined success sentinel) so the web
		// caller can tell a void success from the undefined it returns on failure.
		const updateResult = await asUser.mutation(api.knowledge.graph.updateEntry, {
			entryId,
			title: 'Fixed Title',
			content: 'Corrected content.',
			entryType: 'decision',
			confidence: 0.6,
			tags: ['fixed'],
		});
		expect(updateResult).toBe(entryId);

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(entryId);
			expect(entry!.title).toBe('Fixed Title');
			expect(entry!.content).toBe('Corrected content.');
			expect(entry!.entryType).toBe('decision');
			expect(entry!.confidence).toBe(0.6);
			expect(entry!.tags).toEqual(['fixed']);
			// searchableText recomputed from the new title + content.
			expect(entry!.searchableText).toBe('Fixed Title Corrected content.');
			// Editing re-validates the entry.
			expect(entry!.lastValidatedAt).toBeTypeOf('number');
		});
	});

	it('leaves untouched fields and reconciles the contact junction', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		let contactA!: Id<'contacts'>;
		let contactB!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactA = await ctx.db.insert('contacts', createTestContact());
			contactB = await ctx.db.insert('contacts', createTestContact());
		});

		const entryId = await asUser.mutation(api.knowledge.graph.createEntry, {
			entryType: 'fact',
			title: 'Keeps Title',
			content: 'Original content.',
			sourceType: 'manual',
			contactIds: [contactA],
		});

		// Only swap the linked contact — title/content untouched.
		await asUser.mutation(api.knowledge.graph.updateEntry, {
			entryId,
			contactIds: [contactB],
		});

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(entryId);
			expect(entry!.title).toBe('Keeps Title');
			expect(entry!.content).toBe('Original content.');
			expect(entry!.contactIds).toEqual([contactB]);

			// Junction reconciled: old contact link gone, new one present.
			const aLinks = await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_contact', (q) => q.eq('contactId', contactA))
				.collect();
			expect(aLinks).toHaveLength(0);
			const bLinks = await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_contact', (q) => q.eq('contactId', contactB))
				.collect();
			expect(bLinks).toHaveLength(1);
		});

		// The new contact now surfaces the entry via getByContact.
		const byContact = await asUser.query(api.knowledge.graph.getByContact, { contactId: contactB });
		expect(byContact.map((e) => e._id)).toContain(entryId);
	});

	it('is a no-op for a missing entry id', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		let missingId!: Id<'knowledgeEntries'>;
		await t.run(async (ctx) => {
			missingId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'Temp',
				content: 'temp',
				sourceType: 'manual',
			}));
			await ctx.db.delete(missingId);
		});

		// Should resolve without throwing.
		await expect(
			asUser.mutation(api.knowledge.graph.updateEntry, { entryId: missingId, title: 'X' }),
		).resolves.toBeNull();
	});
});

// ============ knowledgeGraph.deleteEntry ============

describe('knowledgeGraph.deleteEntry', () => {
	it('deletes the entry and tears down junction + relations', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		let contactId!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const entryId = await asUser.mutation(api.knowledge.graph.createEntry, {
			entryType: 'fact',
			title: 'Doomed',
			content: 'to be deleted',
			sourceType: 'manual',
			contactIds: [contactId],
		});

		// A second entry related to the first, both directions.
		let otherId!: Id<'knowledgeEntries'>;
		await t.run(async (ctx) => {
			otherId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'Other',
				content: 'survives',
				sourceType: 'manual',
			}));
			await ctx.db.insert('knowledgeRelations', {
				fromEntryId: entryId,
				toEntryId: otherId,
				relationType: 'relates_to',
				confidenceTag: 'extracted',
				confidence: 1.0,
				provenance: 'manual',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('knowledgeRelations', {
				fromEntryId: otherId,
				toEntryId: entryId,
				relationType: 'supports',
				confidenceTag: 'extracted',
				confidence: 1.0,
				provenance: 'manual',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		// Returns true (a non-undefined success sentinel) so the web caller can tell
		// a void success from the undefined it returns on failure.
		const deleteResult = await asUser.mutation(api.knowledge.graph.deleteEntry, { entryId });
		expect(deleteResult).toBe(true);

		await t.run(async (ctx) => {
			// Entry gone.
			expect(await ctx.db.get(entryId)).toBeNull();
			// The related entry survives.
			expect(await ctx.db.get(otherId)).not.toBeNull();
			// Junction rows gone.
			const links = await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			expect(links).toHaveLength(0);
			// Relations gone in both directions (no dangling rows).
			const outgoing = await ctx.db
				.query('knowledgeRelations')
				.withIndex('by_from', (q) => q.eq('fromEntryId', entryId))
				.collect();
			const incoming = await ctx.db
				.query('knowledgeRelations')
				.withIndex('by_to', (q) => q.eq('toEntryId', entryId))
				.collect();
			expect(outgoing).toHaveLength(0);
			expect(incoming).toHaveLength(0);
		});
	});

	it('is a no-op for a missing entry id', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		let missingId!: Id<'knowledgeEntries'>;
		await t.run(async (ctx) => {
			missingId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'Temp',
				content: 'temp',
				sourceType: 'manual',
			}));
			await ctx.db.delete(missingId);
		});

		await expect(
			asUser.mutation(api.knowledge.graph.deleteEntry, { entryId: missingId }),
		).resolves.toBeNull();
	});

	it('drains relations past the per-page cap before deleting (no dangling rows)', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		const entryId = await asUser.mutation(api.knowledge.graph.createEntry, {
			entryType: 'fact',
			title: 'Hub',
			content: 'many relations',
			sourceType: 'manual',
		});

		// One direction exceeds the 500-row page so the drain loop must paginate.
		// Previously the entry was deleted unconditionally, permanently leaking the
		// rows past the cap (nothing else ever revisits a deleted entry's relations).
		const OVER_PAGE = 501;
		await t.run(async (ctx) => {
			const target = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'Target',
				content: 'pointed at by the hub',
				sourceType: 'manual',
			}));
			for (let i = 0; i < OVER_PAGE; i++) {
				await ctx.db.insert('knowledgeRelations', {
					fromEntryId: entryId,
					toEntryId: target,
					relationType: 'relates_to',
					confidenceTag: 'extracted',
					confidence: 1.0,
					provenance: 'manual',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
		});

		const deleteResult = await asUser.mutation(api.knowledge.graph.deleteEntry, { entryId });
		expect(deleteResult).toBe(true);

		await t.run(async (ctx) => {
			// Entry gone AND every relation row drained — no dangling rows survive.
			expect(await ctx.db.get(entryId)).toBeNull();
			const outgoing = await ctx.db
				.query('knowledgeRelations')
				.withIndex('by_from', (q) => q.eq('fromEntryId', entryId))
				.collect();
			expect(outgoing).toHaveLength(0);
		});
	});
});

// ============ knowledgeGraph.getEntry ============

describe('knowledgeGraph.getEntry', () => {
	it('should return entry with its relations', async () => {
		const t = convexTest(schema, modules);
		let entryId1!: Id<'knowledgeEntries'>;
		let entryId2!: Id<'knowledgeEntries'>;

		await t.run(async (ctx) => {
			entryId1 = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'Entry 1',
				content: 'First entry',
				sourceType: 'manual',
			}));
			entryId2 = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'Entry 2',
				content: 'Second entry',
				sourceType: 'manual',
			}));
			await ctx.db.insert('knowledgeRelations', {
				fromEntryId: entryId1,
				toEntryId: entryId2,
				relationType: 'supports',
				confidenceTag: 'extracted',
				confidence: 1.0,
				provenance: 'manual',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		// Note: getEntry requires auth; use t.run to verify instead
		await t.run(async (ctx) => {
			const entry = await ctx.db.get(entryId1);
			expect(entry).toBeDefined();
			expect(entry!.title).toBe('Entry 1');

			const outgoing = await ctx.db
				.query('knowledgeRelations')
				.withIndex('by_from', (q) => q.eq('fromEntryId', entryId1))
				.collect();
			expect(outgoing).toHaveLength(1);
			expect(outgoing[0]!.toEntryId).toBe(entryId2);
			expect(outgoing[0]!.relationType).toBe('supports');
		});
	});

	it('should return null for missing entry ID via raw DB check', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			// Insert then delete to get a valid but missing ID
			const tempId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'Temp',
				content: 'temp',
				sourceType: 'manual',
			}));
			await ctx.db.delete(tempId);
			const result = await ctx.db.get(tempId);
			expect(result).toBeNull();
		});
	});
});

// ============ knowledgeGraph.listByType ============

describe('knowledgeGraph.listByType', () => {
	it('should filter entries by type', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'fact',
				title: 'Fact 1',
				content: 'fact content',
				sourceType: 'manual',
			}));
			await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'decision',
				title: 'Decision 1',
				content: 'decision content',
				sourceType: 'manual',
			}));
			await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'fact',
				title: 'Fact 2',
				content: 'another fact',
				sourceType: 'manual',
			}));
		});

		// listByType requires auth so verify via raw DB
		await t.run(async (ctx) => {
			const facts = await ctx.db
				.query('knowledgeEntries')
				.withIndex('by_entry_type', (q) => q.eq('entryType', 'fact'))
				.collect();
			expect(facts).toHaveLength(2);
			expect(facts.every((e) => e.entryType === 'fact')).toBe(true);

			const decisions = await ctx.db
				.query('knowledgeEntries')
				.withIndex('by_entry_type', (q) => q.eq('entryType', 'decision'))
				.collect();
			expect(decisions).toHaveLength(1);
		});
	});
});

// ============ knowledgeGraph.listAll ============

describe('knowledgeGraph.listAll', () => {
	it('returns entries of every type, newest first (not just facts)', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		const base = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'fact',
				title: 'A Fact',
				content: 'fact content',
				sourceType: 'manual',
				createdAt: base,
			}));
			await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'decision',
				title: 'A Decision',
				content: 'decision content',
				sourceType: 'manual',
				createdAt: base + 1,
			}));
			await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'goal',
				title: 'A Goal',
				content: 'goal content',
				sourceType: 'manual',
				createdAt: base + 2,
			}));
		});

		const result = await asUser.query(api.knowledge.graph.listAll, {});
		// All three types present — the "All" tab no longer collapses to 'fact'.
		expect(result.map((e) => e.entryType).sort()).toEqual(['decision', 'fact', 'goal']);
		// Newest first.
		expect(result.map((e) => e.title)).toEqual(['A Goal', 'A Decision', 'A Fact']);
	});

	it('respects the limit', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		const base = Date.now();
		await t.run(async (ctx) => {
			for (let i = 0; i < 5; i++) {
				await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
					entryType: 'fact',
					title: `Entry ${i}`,
					content: 'c',
					sourceType: 'manual',
					createdAt: base + i,
				}));
			}
		});

		const result = await asUser.query(api.knowledge.graph.listAll, { limit: 2 });
		expect(result).toHaveLength(2);
	});

	it('returns empty for non-members (and anonymous)', async () => {
		const { isActiveOrgMember } = await import('../lib/sessionOrganization');
		vi.mocked(isActiveOrgMember).mockResolvedValueOnce(false);
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'fact',
				title: 'Hidden',
				content: 'c',
				sourceType: 'manual',
			}));
		});

		const result = await t.query(api.knowledge.graph.listAll, {});
		expect(result).toEqual([]);
	});
});

// ============ knowledgeGraph.getByContact (junction-backed) ============

describe('knowledgeGraph.getByContact', () => {
	it('returns entries linked to a contact via the junction (createEntry path)', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		let contactId!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		await asUser.mutation(api.knowledge.graph.createEntry, {
			entryType: 'fact',
			title: 'Linked Entry',
			content: 'linked',
			sourceType: 'manual',
			contactIds: [contactId],
		});
		await asUser.mutation(api.knowledge.graph.createEntry, {
			entryType: 'fact',
			title: 'Unlinked Entry',
			content: 'not linked',
			sourceType: 'manual',
		});

		const result = await asUser.query(api.knowledge.graph.getByContact, { contactId });
		expect(result).toHaveLength(1);
		expect(result[0]!.title).toBe('Linked Entry');

		// The junction mirror exists for the linked entry.
		await t.run(async (ctx) => {
			const links = await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			expect(links).toHaveLength(1);
		});
	});

	it('returns entries linked via the saveEntry (agent pipeline) path', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		let contactId!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		await t.mutation(internal.knowledge.graph.saveEntry, {
			entryType: 'goal',
			title: 'Agent Goal',
			content: 'extracted goal',
			sourceType: 'agent_extracted',
			embedding: [],
			confidence: 0.9,
			contactIds: [contactId],
		});

		const result = await asUser.query(api.knowledge.graph.getByContact, { contactId });
		expect(result).toHaveLength(1);
		expect(result[0]!.title).toBe('Agent Goal');
	});

	it('is complete past the old 500-row truncation (returns the oldest match)', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		let contactId!: Id<'contacts'>;
		let oldestEntryId!: Id<'knowledgeEntries'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());

			// The single matching entry is the *oldest* row. Then bury it under
			// 600 newer unrelated entries — the legacy `.order('desc').take(500)`
			// scan would never reach it; the junction lookup does.
			const base = Date.now() - 1_000_000;
			oldestEntryId = await ctx.db.insert(
				'knowledgeEntries',
				createTestKnowledgeEntry({
					title: 'Oldest Linked',
					content: 'old but linked',
					sourceType: 'manual',
					contactIds: [contactId],
					createdAt: base,
				}),
			);
			await ctx.db.insert('knowledgeEntryContacts', {
				entryId: oldestEntryId,
				contactId,
			});

			for (let i = 0; i < 600; i++) {
				await ctx.db.insert(
					'knowledgeEntries',
					createTestKnowledgeEntry({
						title: `Noise ${i}`,
						content: 'unrelated',
						sourceType: 'manual',
						createdAt: base + 1000 + i,
					}),
				);
			}
		});

		const result = await asUser.query(api.knowledge.graph.getByContact, { contactId });
		expect(result).toHaveLength(1);
		expect(result[0]!._id).toBe(oldestEntryId);
	});

	it('orders matches by createdAt desc and respects the limit', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		let contactId!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			const base = Date.now();
			for (let i = 0; i < 3; i++) {
				const entryId = await ctx.db.insert(
					'knowledgeEntries',
					createTestKnowledgeEntry({
						title: `Entry ${i}`,
						content: 'c',
						sourceType: 'manual',
						contactIds: [contactId],
						createdAt: base + i, // i=2 is newest
					}),
				);
				await ctx.db.insert('knowledgeEntryContacts', { entryId, contactId });
			}
		});

		const all = await asUser.query(api.knowledge.graph.getByContact, { contactId });
		expect(all.map((e) => e.title)).toEqual(['Entry 2', 'Entry 1', 'Entry 0']);

		const limited = await asUser.query(api.knowledge.graph.getByContact, {
			contactId,
			limit: 2,
		});
		expect(limited.map((e) => e.title)).toEqual(['Entry 2', 'Entry 1']);
	});

	it('drops expired entries even if their junction row lingers', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);

		let contactId!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			const expiredId = await ctx.db.insert(
				'knowledgeEntries',
				createTestKnowledgeEntry({
					title: 'Expired',
					content: 'gone',
					sourceType: 'manual',
					contactIds: [contactId],
					expiresAt: Date.now() - 1000,
				}),
			);
			await ctx.db.insert('knowledgeEntryContacts', { entryId: expiredId, contactId });
		});

		const result = await asUser.query(api.knowledge.graph.getByContact, { contactId });
		expect(result).toHaveLength(0);
	});
});

// ============ knowledgeGraph.saveEntry (internal) ============

describe('knowledgeGraph.saveEntry', () => {
	it('should store entry with embedding from agent pipeline', async () => {
		const t = convexTest(schema, modules);
		const embedding = Array.from({ length: 10 }, (_, i) => i * 0.1);

		const entryId = await t.mutation(internal.knowledge.graph.saveEntry, {
			entryType: 'goal',
			title: 'Agent-extracted Goal',
			content: 'Complete project by Q2.',
			sourceType: 'agent_extracted',
			embedding,
			confidence: 0.9,
			tags: ['q2', 'deadline'],
		});

		expect(entryId).toBeDefined();

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(entryId);
			expect(entry).toBeDefined();
			expect(entry!.entryType).toBe('goal');
			expect(entry!.title).toBe('Agent-extracted Goal');
			expect(entry!.embedding).toEqual(embedding);
			expect(entry!.confidence).toBe(0.9);
			expect(entry!.tags).toEqual(['q2', 'deadline']);
			expect(entry!.searchableText).toBe('Agent-extracted Goal Complete project by Q2.');
			expect(entry!.lastValidatedAt).toBeTypeOf('number');
		});
	});

	it('should store entry with contactIds and threadId', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;
		let threadId!: Id<'conversationThreads'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', {
				subject: 'Test Thread',
				normalizedSubject: 'test thread',
				contactId,
				contactIdentifier: 'test@example.com',
				status: 'open',
				messageCount: 1,
				lastMessageAt: Date.now(),
				firstMessageAt: Date.now(),
				createdAt: Date.now(),
			});
		});

		const entryId = await t.mutation(internal.knowledge.graph.saveEntry, {
			entryType: 'fact',
			title: 'Thread Fact',
			content: 'Fact from a thread.',
			sourceType: 'email',
			embedding: [],
			confidence: 0.85,
			contactIds: [contactId],
			threadId,
		});

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(entryId);
			expect(entry!.contactIds).toEqual([contactId]);
			expect(entry!.threadId).toBe(threadId);
		});
	});
});

// ============ knowledgeGraph.createRelation (internal) ============

describe('knowledgeGraph.createRelation', () => {
	it('should create a relation between two entries', async () => {
		const t = convexTest(schema, modules);
		let entryId1!: Id<'knowledgeEntries'>;
		let entryId2!: Id<'knowledgeEntries'>;

		await t.run(async (ctx) => {
			entryId1 = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'Entry A',
				content: 'content a',
				sourceType: 'manual',
			}));
			entryId2 = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'Entry B',
				content: 'content b',
				sourceType: 'manual',
			}));
		});

		const relationId = await t.mutation(internal.knowledge.graph.createRelation, {
			fromEntryId: entryId1,
			toEntryId: entryId2,
			relationType: 'contradicts',
		});

		expect(relationId).toBeDefined();

		await t.run(async (ctx) => {
			const relation = await ctx.db.get(relationId);
			expect(relation).toBeDefined();
			expect(relation!.fromEntryId).toBe(entryId1);
			expect(relation!.toEntryId).toBe(entryId2);
			expect(relation!.relationType).toBe('contradicts');
			expect(relation!.createdAt).toBeTypeOf('number');
		});
	});

	it('should support all relation types', async () => {
		const t = convexTest(schema, modules);
		let entryId1!: Id<'knowledgeEntries'>;
		let entryId2!: Id<'knowledgeEntries'>;

		await t.run(async (ctx) => {
			entryId1 = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'From',
				content: 'from',
				sourceType: 'manual',
			}));
			entryId2 = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'To',
				content: 'to',
				sourceType: 'manual',
			}));
		});

		const types = ['supports', 'contradicts', 'supersedes', 'relates_to', 'causes', 'blocks'] as const;
		for (const relationType of types) {
			const id = await t.mutation(internal.knowledge.graph.createRelation, {
				fromEntryId: entryId1,
				toEntryId: entryId2,
				relationType,
			});
			expect(id).toBeDefined();
		}

		await t.run(async (ctx) => {
			const relations = await ctx.db
				.query('knowledgeRelations')
				.withIndex('by_from', (q) => q.eq('fromEntryId', entryId1))
				.collect();
			expect(relations).toHaveLength(6);
		});
	});
});

// ============ knowledgeGraph.addRelation / removeRelation (public) ============

describe('knowledgeGraph.addRelation', () => {
	const seedTwoEntries = async (t: ReturnType<typeof convexTest>) => {
		let entryId1!: Id<'knowledgeEntries'>;
		let entryId2!: Id<'knowledgeEntries'>;
		await t.run(async (ctx) => {
			entryId1 = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'Source', content: 'source', sourceType: 'manual',
			}));
			entryId2 = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'Target', content: 'target', sourceType: 'manual',
			}));
		});
		return { entryId1, entryId2 };
	};

	it('creates a relation visible via getEntry', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);
		const { entryId1, entryId2 } = await seedTwoEntries(t);

		const relationId = await asUser.mutation(api.knowledge.graph.addRelation, {
			fromEntryId: entryId1,
			toEntryId: entryId2,
			relationType: 'supports',
		});
		expect(relationId).toBeDefined();

		const detail = await asUser.query(api.knowledge.graph.getEntry, { entryId: entryId1 });
		expect(detail?.outgoing).toHaveLength(1);
		expect(detail?.outgoing[0]?.toEntryId).toBe(entryId2);
		expect(detail?.outgoing[0]?.relationType).toBe('supports');

		// And it shows as incoming on the target.
		const targetDetail = await asUser.query(api.knowledge.graph.getEntry, { entryId: entryId2 });
		expect(targetDetail?.incoming).toHaveLength(1);
		expect(targetDetail?.incoming[0]?.fromEntryId).toBe(entryId1);
	});

	it('de-dupes an identical edge', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);
		const { entryId1, entryId2 } = await seedTwoEntries(t);

		const first = await asUser.mutation(api.knowledge.graph.addRelation, {
			fromEntryId: entryId1, toEntryId: entryId2, relationType: 'relates_to',
		});
		const second = await asUser.mutation(api.knowledge.graph.addRelation, {
			fromEntryId: entryId1, toEntryId: entryId2, relationType: 'relates_to',
		});
		expect(second).toBe(first);

		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('knowledgeRelations')
				.withIndex('by_from', (q) => q.eq('fromEntryId', entryId1))
				.collect();
			expect(rows).toHaveLength(1);
		});
	});

	it('rejects a self-relation', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);
		const { entryId1 } = await seedTwoEntries(t);

		await expect(
			asUser.mutation(api.knowledge.graph.addRelation, {
				fromEntryId: entryId1, toEntryId: entryId1, relationType: 'relates_to',
			}),
		).rejects.toThrow();
	});

	it('rejects a relation to a missing entry', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);
		const { entryId1, entryId2 } = await seedTwoEntries(t);

		await t.run(async (ctx) => { await ctx.db.delete(entryId2); });

		await expect(
			asUser.mutation(api.knowledge.graph.addRelation, {
				fromEntryId: entryId1, toEntryId: entryId2, relationType: 'relates_to',
			}),
		).rejects.toThrow();
	});
});

describe('knowledgeGraph.removeRelation', () => {
	it('removes an existing relation', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);
		let entryId1!: Id<'knowledgeEntries'>;
		let entryId2!: Id<'knowledgeEntries'>;
		await t.run(async (ctx) => {
			entryId1 = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'A', content: 'a', sourceType: 'manual',
			}));
			entryId2 = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'B', content: 'b', sourceType: 'manual',
			}));
		});

		const relationId = await asUser.mutation(api.knowledge.graph.addRelation, {
			fromEntryId: entryId1, toEntryId: entryId2, relationType: 'blocks',
		});

		const result = await asUser.mutation(api.knowledge.graph.removeRelation, {
			relationId: relationId as Id<'knowledgeRelations'>,
		});
		expect(result).toBe(true);

		const detail = await asUser.query(api.knowledge.graph.getEntry, { entryId: entryId1 });
		expect(detail?.outgoing).toHaveLength(0);
	});

	it('is a no-op for an already-deleted relation', async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity(testUser);
		let entryId1!: Id<'knowledgeEntries'>;
		let entryId2!: Id<'knowledgeEntries'>;
		let relationId!: Id<'knowledgeRelations'>;
		await t.run(async (ctx) => {
			entryId1 = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'A', content: 'a', sourceType: 'manual',
			}));
			entryId2 = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'B', content: 'b', sourceType: 'manual',
			}));
			relationId = await ctx.db.insert('knowledgeRelations', {
				fromEntryId: entryId1, toEntryId: entryId2, relationType: 'causes',
				confidenceTag: 'extracted', confidence: 1.0, provenance: 'manual',
				createdAt: Date.now(), updatedAt: Date.now(),
			});
			await ctx.db.delete(relationId);
		});

		const result = await asUser.mutation(api.knowledge.graph.removeRelation, { relationId });
		expect(result).toBeNull();
	});
});

// ============ knowledgeGraph.updateConfidence (internal) ============

describe('knowledgeGraph.updateConfidence', () => {
	it('should update confidence and lastValidatedAt', async () => {
		const t = convexTest(schema, modules);
		let entryId!: Id<'knowledgeEntries'>;

		await t.run(async (ctx) => {
			entryId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'Updatable',
				content: 'will be updated',
				sourceType: 'manual',
				confidence: 0.5,
			}));
		});

		await t.mutation(internal.knowledge.graph.updateConfidence, {
			entryId,
			confidence: 0.95,
		});

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(entryId);
			expect(entry!.confidence).toBe(0.95);
			expect(entry!.lastValidatedAt).toBeTypeOf('number');
			expect(entry!.updatedAt).toBeTypeOf('number');
		});
	});

	it('should use provided lastValidatedAt when specified', async () => {
		const t = convexTest(schema, modules);
		let entryId!: Id<'knowledgeEntries'>;

		await t.run(async (ctx) => {
			entryId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'Validated',
				content: 'custom validation time',
				sourceType: 'manual',
			}));
		});

		const customTime = 1700000000000;
		await t.mutation(internal.knowledge.graph.updateConfidence, {
			entryId,
			confidence: 0.7,
			lastValidatedAt: customTime,
		});

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(entryId);
			expect(entry!.confidence).toBe(0.7);
			expect(entry!.lastValidatedAt).toBe(customTime);
		});
	});
});

