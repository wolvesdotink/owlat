import { describe, it, expect } from 'vitest';
import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import { createTestContact } from './factories';
import { newHarness } from './testModules';
import {
	contactReferencesIn,
	referencesTo,
	schemaContactReferences,
	schemaStringContactReferences,
	schemaStringFields,
	stringFieldsIn,
	stringReferencesTo,
} from './schemaReferences';
import {
	DECLARED_CONTACT_STRING_REFERENCES,
	NOT_CONTACT_STRING_REFERENCES,
} from '../lib/contactStringReferences';
import {
	CONTACT_MERGE_EXCLUSIONS,
	CONTACT_MERGE_ROUTINES,
	CONTACT_REPOINT_TABLES,
	mergeContactRelations,
} from '../lib/contactMutations';

/**
 * Schema coverage gate for the contact merge cascade (`mergeContactRelations`
 * in `lib/contactMutations.ts`), the merge-side twin of
 * `contactErasureRelations.test.ts`. Both merge paths hard-delete the source
 * contact afterwards, so a `v.id('contacts')` field the merge does not move is
 * left pointing at a deleted contact, out of reach of the survivor's erasure
 * (clarificationMemory and answerAskSessions were, #1337). A new field fails
 * here until it is repointed, given a routine, or excluded with a reason.
 *
 * A contact id kept in a plain string is invisible to the `v.id` walk, so the
 * gate also takes the string fields `stringReferencesTo` recognises as contact
 * ids (see its rule in `schemaReferences.ts`). Those must be handled the same
 * way, and the executable fixtures in `contactErasureRelationCoverage.test.ts`
 * seed them through their discriminator, so a missing merge or erasure
 * handler fails a test rather than only a list comparison.
 */

const handled = (): string[] => [
	...CONTACT_REPOINT_TABLES.map((table) => `${table}.contactId`),
	...CONTACT_MERGE_ROUTINES,
	...Object.keys(CONTACT_MERGE_EXCLUSIONS),
];

describe('contact merge relation coverage', () => {
	it('handles every field in the schema that references contacts', () => {
		expect([...handled()].sort()).toEqual(schemaContactReferences());
	});

	it('declares only plain-string contact ids the name rule cannot see', () => {
		const strings = new Set(schemaStringFields());
		const recognised = new Set(schemaStringContactReferences().map((r) => r.ref));
		for (const [ref, why] of Object.entries(DECLARED_CONTACT_STRING_REFERENCES)) {
			expect(strings.has(ref), `${ref} is not a plain string in the schema`).toBe(true);
			expect(recognised.has(ref), `${ref} is already found by its name`).toBe(false);
			expect(why.trim().length, ref).toBeGreaterThan(0);
		}
	});

	it('exempts only strings the name rule actually claims', () => {
		const recognised = new Set(schemaStringContactReferences().map((r) => r.ref));
		for (const [ref, why] of Object.entries(NOT_CONTACT_STRING_REFERENCES)) {
			expect(recognised.has(ref), `${ref} is not claimed by the name rule`).toBe(true);
			expect(why.trim().length, ref).toBeGreaterThan(0);
		}
	});

	it('handles each field one way only', () => {
		expect(new Set(handled()).size).toBe(handled().length);
	});

	it('gives every exclusion a reason', () => {
		for (const [field, why] of Object.entries(CONTACT_MERGE_EXCLUSIONS)) {
			expect(why.trim().length, field).toBeGreaterThan(0);
		}
	});
});

describe('schema reference walk', () => {
	it('counts a field once when both walks find it, and adds declared strings', () => {
		const tables = {
			mixed: { validator: v.object({ contactId: v.union(v.id('contacts'), v.string()) }) },
			hidden: {
				validator: v.object({ owner: v.string(), keyed: v.record(v.string(), v.number()) }),
			},
		};
		expect(
			contactReferencesIn(tables, { 'hidden.owner': 'why', 'hidden.keyed{key}': 'why' }, {})
		).toEqual(['hidden.keyed{key}', 'hidden.owner', 'mixed.contactId']);
		expect(stringFieldsIn(tables)).toEqual([
			'hidden.keyed{key}',
			'hidden.owner',
			'mixed.contactId',
		]);
	});

	it('recognises contact ids held in plain strings by their discriminator or name', () => {
		const tables = {
			scoped: {
				validator: v.object({
					organizationId: v.string(),
					scopeType: v.union(v.literal('mailbox'), v.literal('contact')),
					scopeId: v.string(),
				}),
			},
			audited: {
				validator: v.object({
					resource: v.union(v.literal('contact'), v.literal('campaign')),
					resourceId: v.optional(v.string()),
					userId: v.string(),
				}),
			},
			otherKind: {
				validator: v.object({ targetType: v.literal('mailbox'), targetId: v.string() }),
			},
			named: {
				validator: v.object({ fromContactId: v.string(), contactIds: v.array(v.string()) }),
			},
			typed: { validator: v.object({ contactId: v.id('contacts') }) },
			containers: {
				validator: v.object({
					contactIds: v.union(v.array(v.string()), v.null()),
					grid: v.object({ contactIds: v.array(v.array(v.string())) }),
					byContact: v.optional(v.object({ contactIds: v.record(v.string(), v.string()) })),
					scopeType: v.literal('contact'),
					scopeIds: v.array(v.string()),
					nested: v.array(
						v.object({ targetKind: v.literal('contact'), targetId: v.optional(v.string()) })
					),
				}),
			},
		};
		expect(stringReferencesTo(tables, 'contact')).toEqual([
			{ ref: 'audited.resourceId', discriminator: 'resource' },
			{ ref: 'containers.byContact.contactIds{}' },
			{ ref: 'containers.contactIds[]' },
			{ ref: 'containers.grid.contactIds[][]' },
			{ ref: 'containers.nested[].targetId', discriminator: 'targetKind' },
			{ ref: 'containers.scopeIds[]', discriminator: 'scopeType' },
			{ ref: 'named.contactIds[]' },
			{ ref: 'named.fromContactId' },
			{ ref: 'scoped.scopeId', discriminator: 'scopeType' },
		]);
	});

	it('finds ids in nested objects, arrays, unions, and record keys and values', () => {
		const tables = {
			plain: { validator: v.object({ contactId: v.id('contacts'), other: v.id('topics') }) },
			nested: {
				validator: v.object({
					a: v.object({ b: v.array(v.union(v.id('contacts'), v.null())) }),
				}),
			},
			keyed: { validator: v.object({ byContact: v.record(v.id('contacts'), v.string()) }) },
			valued: { validator: v.object({ toContact: v.record(v.string(), v.id('contacts')) }) },
		};
		expect(referencesTo(tables, 'contacts')).toEqual([
			'keyed.byContact{key}',
			'nested.a.b[]',
			'plain.contactId',
			'valued.toContact{}',
		]);
	});
});

const NOW = Date.UTC(2026, 9, 13);

function answer(
	contactId: Id<'contacts'>,
	questionKey: string,
	fields: Partial<{
		answerValue: string;
		answerCount: number;
		useCount: number;
		createdAt: number;
		updatedAt: number;
		lastUsedAt: number;
	}> = {}
) {
	return {
		contactId,
		slotType: 'date',
		questionKey,
		questionText: `${questionKey}?`,
		answerValue: 'answer',
		source: 'agent' as const,
		answerCount: 1,
		useCount: 0,
		createdAt: NOW,
		updatedAt: NOW,
		...fields,
	};
}

describe('learned clarification answers across a merge', () => {
	it('moves the source’s answers and keeps the newer one on a shared question', async () => {
		const t = newHarness();
		const { targetId, sourceId } = await t.run(async (ctx) => {
			const targetId = await ctx.db.insert('contacts', createTestContact());
			const sourceId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert(
				'clarificationMemory',
				answer(targetId, 'date::deadline', {
					answerValue: 'Friday',
					answerCount: 2,
					useCount: 3,
					updatedAt: NOW,
					lastUsedAt: NOW,
				})
			);
			await ctx.db.insert(
				'clarificationMemory',
				answer(sourceId, 'date::deadline', {
					answerValue: 'Monday',
					answerCount: 1,
					useCount: 4,
					createdAt: NOW - 1000,
					updatedAt: NOW + 1000,
				})
			);
			await ctx.db.insert(
				'clarificationMemory',
				answer(sourceId, 'date::start', { answerValue: 'June' })
			);
			await ctx.db.insert(
				'clarificationMemory',
				answer(targetId, 'date::end', { answerValue: 'July', updatedAt: NOW + 5000 })
			);
			return { targetId, sourceId };
		});

		await t.run((ctx) => mergeContactRelations(ctx, targetId, sourceId));

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('clarificationMemory').collect();
			expect(rows.every((row) => row.contactId === targetId)).toBe(true);
			const byKey = new Map(rows.map((row) => [row.questionKey, row]));
			expect([...byKey.keys()].sort()).toEqual(['date::deadline', 'date::end', 'date::start']);
			expect(rows).toHaveLength(3);
			expect(byKey.get('date::deadline')).toMatchObject({
				answerValue: 'Monday',
				answerCount: 3,
				useCount: 7,
				createdAt: NOW - 1000,
				updatedAt: NOW + 1000,
				lastUsedAt: NOW,
			});
			expect(byKey.get('date::start')?.answerValue).toBe('June');
			expect(byKey.get('date::end')?.answerValue).toBe('July');
		});
	});

	it('keeps the target’s answer when it is the newer one', async () => {
		const t = newHarness();
		const { targetId, sourceId } = await t.run(async (ctx) => {
			const targetId = await ctx.db.insert('contacts', createTestContact());
			const sourceId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert(
				'clarificationMemory',
				answer(targetId, 'date::deadline', { answerValue: 'Friday', updatedAt: NOW + 1000 })
			);
			await ctx.db.insert(
				'clarificationMemory',
				answer(sourceId, 'date::deadline', { answerValue: 'Monday', lastUsedAt: NOW + 50 })
			);
			return { targetId, sourceId };
		});

		await t.run((ctx) => mergeContactRelations(ctx, targetId, sourceId));

		const rows = await t.run((ctx) => ctx.db.query('clarificationMemory').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			contactId: targetId,
			answerValue: 'Friday',
			answerCount: 2,
			lastUsedAt: NOW + 50,
		});
	});

	it('leaves organization-wide answers alone', async () => {
		const t = newHarness();
		const { targetId, sourceId, orgWideId } = await t.run(async (ctx) => {
			const targetId = await ctx.db.insert('contacts', createTestContact());
			const sourceId = await ctx.db.insert('contacts', createTestContact());
			const { contactId: _, ...orgWide } = answer(sourceId, 'date::deadline');
			const orgWideId = await ctx.db.insert('clarificationMemory', orgWide);
			return { targetId, sourceId, orgWideId };
		});

		await t.run((ctx) => mergeContactRelations(ctx, targetId, sourceId));

		const row = await t.run((ctx) => ctx.db.get(orgWideId));
		expect(row?.contactId).toBeUndefined();
	});
});

function selection(scopeId: string, strategyKind: string, updatedAt: number) {
	return {
		organizationId: 'org-1',
		scopeType: 'contact' as const,
		scopeId,
		strategyKind,
		createdAt: NOW,
		updatedAt,
	};
}

describe('draft strategy overrides across a merge', () => {
	it('moves the source’s override onto the survivor', async () => {
		const t = newHarness();
		const { targetId, sourceId, rowId } = await t.run(async (ctx) => {
			const targetId = await ctx.db.insert('contacts', createTestContact());
			const sourceId = await ctx.db.insert('contacts', createTestContact());
			const rowId = await ctx.db.insert(
				'draftStrategySelections',
				selection(sourceId, 'concise', NOW)
			);
			return { targetId, sourceId, rowId };
		});

		await t.run((ctx) => mergeContactRelations(ctx, targetId, sourceId));

		expect(await t.run((ctx) => ctx.db.get(rowId))).toMatchObject({
			scopeType: 'contact',
			scopeId: targetId,
			strategyKind: 'concise',
		});
	});

	it('keeps one override, the newer one, when both contacts have one', async () => {
		const t = newHarness();
		const { targetId, sourceId } = await t.run(async (ctx) => {
			const targetId = await ctx.db.insert('contacts', createTestContact());
			const sourceId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert('draftStrategySelections', selection(targetId, 'concise', NOW));
			await ctx.db.insert('draftStrategySelections', selection(sourceId, 'formal', NOW + 1000));
			return { targetId, sourceId };
		});

		await t.run((ctx) => mergeContactRelations(ctx, targetId, sourceId));

		const rows = await t.run((ctx) => ctx.db.query('draftStrategySelections').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ scopeId: targetId, strategyKind: 'formal' });
	});

	it('keeps the survivor’s override when it is the newer one', async () => {
		const t = newHarness();
		const { targetId, sourceId } = await t.run(async (ctx) => {
			const targetId = await ctx.db.insert('contacts', createTestContact());
			const sourceId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert('draftStrategySelections', selection(targetId, 'concise', NOW + 1000));
			await ctx.db.insert('draftStrategySelections', selection(sourceId, 'formal', NOW));
			return { targetId, sourceId };
		});

		await t.run((ctx) => mergeContactRelations(ctx, targetId, sourceId));

		const rows = await t.run((ctx) => ctx.db.query('draftStrategySelections').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ scopeId: targetId, strategyKind: 'concise' });
	});
});
