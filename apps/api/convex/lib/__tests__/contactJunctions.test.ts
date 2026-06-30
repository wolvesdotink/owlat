import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { createTestContact } from '../../__tests__/factories';
import {
	repointContactJunction,
	detachContactJunction,
	KNOWLEDGE_ENTRY_JUNCTION,
} from '../contactJunctions';
import type { Id } from '../../_generated/dataModel';

const modules = import.meta.glob('../../**/*.*s');

/**
 * Guards the contact-merge junction invariant: when a junction row is repointed
 * from the source onto the target contact, the parent row's mirrored
 * `contactIds` array MUST move in lock-step with the `knowledgeEntryContacts`
 * junction — the "array must stay in sync with the junction" drift hazard that
 * was open-coded ~3× before `repointContactJunction` owned it.
 */
describe('repointContactJunction (knowledge entry junction)', () => {
	const entryBase = {
		entryType: 'fact' as const,
		title: 'fact',
		sourceType: 'manual' as const,
		embedding: [0.1, 0.2],
		confidence: 0.9,
		lastValidatedAt: Date.now(),
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	it('repoints a source-only entry: junction row AND mirror array both move to the target', async () => {
		const t = convexTest(schema, modules);

		const ids = await t.run(async (ctx) => {
			const targetId = await ctx.db.insert('contacts', createTestContact());
			const sourceId = await ctx.db.insert('contacts', createTestContact());

			// Entry linked ONLY to the source — no conflict on the target.
			const entryId = await ctx.db.insert('knowledgeEntries', {
				...entryBase,
				content: 'Prefers EUR invoices',
				contactIds: [sourceId],
			} as never);
			await ctx.db.insert('knowledgeEntryContacts', { entryId, contactId: sourceId });

			return { targetId, sourceId, entryId };
		});

		await t.run(async (ctx) => {
			await repointContactJunction(
				ctx,
				KNOWLEDGE_ENTRY_JUNCTION,
				ids.targetId,
				ids.sourceId,
			);
		});

		await t.run(async (ctx) => {
			// Mirror array now points at the target, not the source.
			const entry = await ctx.db.get(ids.entryId);
			expect(entry?.contactIds).toEqual([ids.targetId]);

			// The single junction row now belongs to the target.
			const links = await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_entry', (q) => q.eq('entryId', ids.entryId))
				.collect();
			expect(links).toHaveLength(1);
			expect(links[0]?.contactId).toBe(ids.targetId);

			// No junction row left on the source.
			const sourceLinks = await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_contact', (q) => q.eq('contactId', ids.sourceId))
				.collect();
			expect(sourceLinks).toHaveLength(0);
		});
	});

	it('dedupes when the target already shares the entry: drops the redundant source row and strips it from the mirror', async () => {
		const t = convexTest(schema, modules);

		const ids = await t.run(async (ctx) => {
			const targetId = await ctx.db.insert('contacts', createTestContact());
			const sourceId = await ctx.db.insert('contacts', createTestContact());

			// Entry already linked to BOTH — a (entry, contact) conflict on merge.
			const entryId = await ctx.db.insert('knowledgeEntries', {
				...entryBase,
				content: 'Works at ACME',
				contactIds: [targetId, sourceId],
			} as never);
			await ctx.db.insert('knowledgeEntryContacts', { entryId, contactId: targetId });
			await ctx.db.insert('knowledgeEntryContacts', { entryId, contactId: sourceId });

			return { targetId, sourceId, entryId };
		});

		await t.run(async (ctx) => {
			await repointContactJunction(
				ctx,
				KNOWLEDGE_ENTRY_JUNCTION,
				ids.targetId,
				ids.sourceId,
			);
		});

		await t.run(async (ctx) => {
			// Mirror array keeps the target once, drops the source — no duplicate.
			const entry = await ctx.db.get(ids.entryId);
			expect(entry?.contactIds).toEqual([ids.targetId]);

			// Exactly one junction row survives, on the target.
			const links = await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_entry', (q) => q.eq('entryId', ids.entryId))
				.collect();
			expect(links).toHaveLength(1);
			expect(links[0]?.contactId).toBe(ids.targetId);
		});
	});
});

/**
 * The delete-cascade counterpart: detaching a contact unlinks its junction rows
 * and strips it from each parent's mirror array, leaving co-linked contacts and
 * the parent row itself intact.
 */
describe('detachContactJunction (knowledge entry junction)', () => {
	it('removes the junction row and the mirror entry, keeping other contacts linked', async () => {
		const t = convexTest(schema, modules);

		const ids = await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const otherId = await ctx.db.insert('contacts', createTestContact());

			const entryId = await ctx.db.insert('knowledgeEntries', {
				entryType: 'fact' as const,
				title: 'fact',
				sourceType: 'manual' as const,
				embedding: [0.1, 0.2],
				confidence: 0.9,
				lastValidatedAt: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
				content: 'Shared fact',
				contactIds: [contactId, otherId] as Id<'contacts'>[],
			} as never);
			await ctx.db.insert('knowledgeEntryContacts', { entryId, contactId });
			await ctx.db.insert('knowledgeEntryContacts', { entryId, contactId: otherId });

			return { contactId, otherId, entryId };
		});

		await t.run(async (ctx) => {
			await detachContactJunction(ctx, KNOWLEDGE_ENTRY_JUNCTION, ids.contactId);
		});

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(ids.entryId);
			expect(entry).not.toBeNull();
			expect(entry?.contactIds).toEqual([ids.otherId]);

			const links = await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_entry', (q) => q.eq('entryId', ids.entryId))
				.collect();
			expect(links).toHaveLength(1);
			expect(links[0]?.contactId).toBe(ids.otherId);
		});
	});
});
