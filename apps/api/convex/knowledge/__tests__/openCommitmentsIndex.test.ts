/**
 * Open-commitments recall on the junction projection (issue #919).
 *
 * `knowledge.graph.getOpenCommitmentsByContact` used to load every knowledge
 * entry linked to the contact to return at most ten. These tests pin the new
 * cost (entry loads scale with the answer, not with the contact's knowledge)
 * and the behaviour it must keep: open = decision / action_item without a
 * fulfilled / cancelled status, soonest due first, undated last, newest first
 * on ties, TTL honoured, contact scope kept, and every writer (create, edit,
 * status change, policy edit, dedup merge, contact merge, backfill) keeping
 * the projection in step.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { modules } from '../../__tests__/testModules';
import { createTestContact, enableFeatures } from '../../__tests__/factories';
import { getOpenCommitmentsByContact } from '../graph';
import { KNOWLEDGE_ENTRY_JUNCTION, repointContactJunction } from '../../lib/contactJunctions';
import type * as SessionOrganization from '../../lib/sessionOrganization';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../../lib/sessionOrganization');
	const session = { userId: 'test-user', role: 'owner', activeOrganizationId: 'test-org' };
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue(session),
		requireAdminContext: vi.fn().mockResolvedValue(session),
	};
});

type Harness = ReturnType<typeof convexTest>;
type EntryFields = Partial<Omit<Doc<'knowledgeEntries'>, '_id' | '_creationTime'>>;

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 0, 1);

function entryDoc(fields: EntryFields) {
	return {
		entryType: 'fact' as const,
		title: 'Entry',
		content: 'Content',
		sourceType: 'agent_extracted' as const,
		embedding: [],
		confidence: 0.8,
		lastValidatedAt: BASE,
		createdAt: BASE,
		updatedAt: BASE,
		...fields,
	};
}

async function newContact(t: Harness): Promise<Id<'contacts'>> {
	return t.run((ctx) => ctx.db.insert('contacts', createTestContact()));
}

/** A row as written before the projection existed: entry + bare junction row. */
async function insertLegacy(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
	fields: EntryFields
): Promise<Id<'knowledgeEntries'>> {
	const entryId = await ctx.db.insert(
		'knowledgeEntries',
		entryDoc({ contactIds: [contactId], ...fields })
	);
	await ctx.db.insert('knowledgeEntryContacts', { entryId, contactId });
	return entryId;
}

/** The live pipeline writer. */
async function save(
	t: Harness,
	contactIds: Id<'contacts'>[],
	fields: {
		entryType: Doc<'knowledgeEntries'>['entryType'];
		title: string;
		expiresAt?: number;
		embedding?: number[];
		confidence?: number;
	}
): Promise<Id<'knowledgeEntries'>> {
	// One second per write, so every entry has its own createdAt.
	vi.setSystemTime(Date.now() + 1_000);
	return t.mutation(internal.knowledge.graph.saveEntry, {
		entryType: fields.entryType,
		title: fields.title,
		content: `${fields.title} (content)`,
		sourceType: 'agent_extracted',
		contactIds,
		embedding: fields.embedding ?? [],
		confidence: fields.confidence ?? 0.8,
		expiresAt: fields.expiresAt,
	});
}

async function backfill(t: Harness): Promise<{ pages: number; projected: number }> {
	let cursor: string | null = null;
	let pages = 0;
	let projected = 0;
	for (;;) {
		const page: { cursor: string; isDone: boolean; projected: number } = await t.mutation(
			internal.migrations['0053_project_open_commitments'].projectPage,
			{ cursor }
		);
		pages++;
		projected += page.projected;
		if (page.isDone) return { pages, projected };
		cursor = page.cursor;
	}
}

async function titles(t: Harness, contactId: Id<'contacts'>, limit?: number): Promise<string[]> {
	const rows = await t.query(internal.knowledge.graph.getOpenCommitmentsByContact, {
		contactId,
		limit,
		includeInboxDerived: true,
	});
	return rows.map((r) => r.title);
}

/** Run the real handler with `ctx.db.get` counted per table. */
async function countedRecall(
	t: Harness,
	contactId: Id<'contacts'>
): Promise<{ titles: string[]; entryLoads: number; hasEmbedding: boolean }> {
	const handler = (
		getOpenCommitmentsByContact as unknown as {
			_handler: (ctx: unknown, args: unknown) => Promise<Array<Record<string, unknown>>>;
		}
	)._handler;
	return t.run(async (ctx) => {
		let entryLoads = 0;
		const db = new Proxy(ctx.db, {
			get(target, prop) {
				if (prop === 'get') {
					return async (id: Id<'knowledgeEntries'>) => {
						const doc = await target.get(id);
						if (doc && 'embedding' in doc) entryLoads++;
						return doc;
					};
				}
				const value = Reflect.get(target, prop) as unknown;
				return typeof value === 'function'
					? (value as (...a: unknown[]) => unknown).bind(target)
					: value;
			},
		});
		const rows = await handler({ ...ctx, db }, { contactId, includeInboxDerived: true });
		return {
			titles: rows.map((r) => r['title'] as string),
			entryLoads,
			hasEmbedding: rows.some((r) => 'embedding' in r),
		};
	});
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(BASE + 100 * DAY);
});
afterEach(() => vi.useRealTimers());

describe('open-commitments recall reads the junction projection', () => {
	it(
		'10,000 unrelated facts: returns the due-ordered answer and loads only the returned entries',
		{ timeout: 180_000 },
		async () => {
			const t = convexTest(schema, modules);
			// The public knowledge functions follow the `ai.knowledge` flag.
			await enableFeatures(t, ['ai.knowledge']);
			const contactId = await newContact(t);
			const otherId = await newContact(t);

			// Pre-projection history: 10,000 facts, fulfilled / cancelled
			// commitments and an expired open one, all older than the answer.
			for (let chunk = 0; chunk < 10; chunk++) {
				await t.run(async (ctx) => {
					for (let i = 0; i < 1_000; i++) {
						const n = chunk * 1_000 + i;
						await insertLegacy(ctx, contactId, { title: `Fact ${n}`, createdAt: BASE + n });
					}
				});
			}
			await t.run(async (ctx) => {
				for (let i = 0; i < 200; i++) {
					await insertLegacy(ctx, contactId, {
						entryType: 'action_item',
						title: `Done ${i}`,
						commitmentStatus: 'fulfilled',
						dueAt: BASE + i,
					});
				}
				for (let i = 0; i < 50; i++) {
					await insertLegacy(ctx, contactId, {
						entryType: 'decision',
						title: `Cancelled ${i}`,
						commitmentStatus: 'cancelled',
					});
				}
				await insertLegacy(ctx, contactId, {
					entryType: 'action_item',
					title: 'Expired promise',
					dueAt: BASE,
					expiresAt: BASE + DAY,
				});
				// Another contact's open promise, due first: must not leak.
				await insertLegacy(ctx, otherId, {
					entryType: 'action_item',
					title: 'Other contact',
					dueAt: BASE,
				});
			});

			const run = await backfill(t);
			expect(run.projected).toBe(10_252);

			// The answer, written by the live writer after the backfill.
			const undatedOld = await save(t, [contactId], {
				entryType: 'action_item',
				title: 'Undated older',
			});
			const undatedNew = await save(t, [contactId], {
				entryType: 'decision',
				title: 'Undated newer',
			});
			const later = await save(t, [contactId], { entryType: 'decision', title: 'Due later' });
			const soon = await save(t, [contactId], { entryType: 'action_item', title: 'Due soon' });
			const resolved = await save(t, [contactId], { entryType: 'action_item', title: 'Resolved' });
			await t.mutation(api.knowledge.graph.setCommitmentStatus, {
				entryId: later,
				commitmentStatus: 'open',
				dueAt: BASE + 120 * DAY,
			});
			await t.mutation(api.knowledge.graph.setCommitmentStatus, {
				entryId: soon,
				commitmentStatus: 'open',
				dueAt: BASE + 101 * DAY,
			});
			await t.mutation(api.knowledge.graph.setCommitmentStatus, {
				entryId: resolved,
				commitmentStatus: 'fulfilled',
			});
			expect([undatedOld, undatedNew]).toHaveLength(2);

			const recall = await countedRecall(t, contactId);
			expect(recall.titles).toEqual(['Due soon', 'Due later', 'Undated newer', 'Undated older']);
			// Entry loads follow the answer, not the 10,256 linked entries.
			expect(recall.entryLoads).toBe(4);
			expect(recall.hasEmbedding).toBe(false);

			expect(await titles(t, contactId, 2)).toEqual(['Due soon', 'Due later']);
			expect(await titles(t, otherId)).toEqual(['Other contact']);
		}
	);

	it('merges rows written before the projection with projected ones', async () => {
		const t = convexTest(schema, modules);
		// The public knowledge functions follow the `ai.knowledge` flag.
		await enableFeatures(t, ['ai.knowledge']);
		const contactId = await newContact(t);
		const now = Date.now();
		await t.run(async (ctx) => {
			await insertLegacy(ctx, contactId, {
				entryType: 'action_item',
				title: 'Legacy undated',
				createdAt: now - 10,
			});
			await insertLegacy(ctx, contactId, {
				entryType: 'decision',
				title: 'Legacy due',
				dueAt: now + DAY,
			});
			await insertLegacy(ctx, contactId, {
				entryType: 'action_item',
				title: 'Legacy fulfilled',
				commitmentStatus: 'fulfilled',
			});
			await insertLegacy(ctx, contactId, { entryType: 'fact', title: 'Legacy fact' });
		});
		await save(t, [contactId], { entryType: 'action_item', title: 'New undated' });

		expect(await titles(t, contactId)).toEqual(['Legacy due', 'New undated', 'Legacy undated']);
		expect(await titles(t, contactId, 1)).toEqual(['Legacy due']);

		// The backfill changes the cost, not the answer; a second run writes nothing.
		expect((await backfill(t)).projected).toBe(4);
		expect(await titles(t, contactId)).toEqual(['Legacy due', 'New undated', 'Legacy undated']);
		expect((await backfill(t)).projected).toBe(0);
	});

	it('skips expired candidates without loading them', async () => {
		const t = convexTest(schema, modules);
		// The public knowledge functions follow the `ai.knowledge` flag.
		await enableFeatures(t, ['ai.knowledge']);
		const contactId = await newContact(t);
		const now = Date.now();
		for (let i = 0; i < 20; i++) {
			await save(t, [contactId], {
				entryType: 'action_item',
				title: `Expired ${i}`,
				expiresAt: now - 1,
			});
		}
		await save(t, [contactId], { entryType: 'action_item', title: 'Live' });
		const recall = await countedRecall(t, contactId);
		expect(recall.titles).toEqual(['Live']);
		expect(recall.entryLoads).toBe(1);
	});

	it('leaves Team Inbox-derived commitments out unless the caller includes them', async () => {
		const t = convexTest(schema, modules);
		const contactId = await newContact(t);
		await save(t, [contactId], { entryType: 'action_item', title: 'From the Team Inbox' });
		await t.run(async (ctx) => {
			await insertLegacy(ctx, contactId, {
				entryType: 'action_item',
				title: 'Written by hand',
				sourceType: 'manual',
			});
		});

		const recall = (includeInboxDerived: boolean) =>
			t.query(internal.knowledge.graph.getOpenCommitmentsByContact, {
				contactId,
				includeInboxDerived,
			});
		expect((await recall(true)).map((r) => r.title).sort()).toEqual([
			'From the Team Inbox',
			'Written by hand',
		]);
		expect((await recall(false)).map((r) => r.title)).toEqual(['Written by hand']);
	});

	it('follows edits: type change, expiry, policy conversion, reopening', async () => {
		const t = convexTest(schema, modules);
		// The public knowledge functions follow the `ai.knowledge` flag.
		await enableFeatures(t, ['ai.knowledge']);
		const contactId = await newContact(t);
		const a = await save(t, [contactId], { entryType: 'action_item', title: 'A' });
		const b = await save(t, [contactId], { entryType: 'action_item', title: 'B' });
		const c = await save(t, [contactId], { entryType: 'decision', title: 'C' });
		const d = await save(t, [contactId], { entryType: 'fact', title: 'D' });
		expect(await titles(t, contactId)).toEqual(['C', 'B', 'A']);

		await t.mutation(api.knowledge.graph.updateEntry, { entryId: a, entryType: 'fact' });
		await t.mutation(api.knowledge.graph.updateEntry, { entryId: b, expiresAt: Date.now() - 1 });
		await t.mutation(api.knowledge.graph.createPolicyEntry, {
			entryId: c,
			title: 'C',
			content: 'Policy',
		});
		expect(await titles(t, contactId)).toEqual([]);

		await t.mutation(api.knowledge.graph.updateEntry, { entryId: d, entryType: 'action_item' });
		await t.mutation(api.knowledge.graph.setCommitmentStatus, {
			entryId: a,
			commitmentStatus: 'cancelled',
		});
		await t.mutation(api.knowledge.graph.updateEntry, { entryId: a, entryType: 'decision' });
		expect(await titles(t, contactId)).toEqual(['D']);

		await t.mutation(api.knowledge.graph.setCommitmentStatus, {
			entryId: a,
			commitmentStatus: 'open',
		});
		expect(await titles(t, contactId)).toEqual(['D', 'A']);

		// Re-scoping an entry rewrites its junction rows with the facets.
		const other = await newContact(t);
		await t.mutation(api.knowledge.graph.updateEntry, { entryId: d, contactIds: [other] });
		expect(await titles(t, contactId)).toEqual(['A']);
		expect(await titles(t, other)).toEqual(['D']);
	});

	it('keeps the projection through a dedup merge and a contact merge', async () => {
		const t = convexTest(schema, modules);
		// The public knowledge functions follow the `ai.knowledge` flag.
		await enableFeatures(t, ['ai.knowledge']);
		const contactA = await newContact(t);
		const contactB = await newContact(t);
		const same = [1, 0, 0];
		// Survivor (higher confidence) is an open promise to A; the loser, a
		// fact about B, folds into it, so B inherits the open promise.
		await save(t, [contactA], {
			entryType: 'action_item',
			title: 'Survivor',
			embedding: same,
			confidence: 0.9,
		});
		const loser = await save(t, [contactB], {
			entryType: 'fact',
			title: 'Loser',
			embedding: same,
			confidence: 0.5,
		});
		await t.mutation(api.knowledge.graph.updateEntry, {
			entryId: loser,
			contactIds: [contactA, contactB],
		});
		expect(await titles(t, contactB)).toEqual([]);

		const merged = await t.mutation(internal.knowledge.maintenance.dedupeContactEntries, {
			contactId: contactA,
		});
		expect(merged.merged).toBe(1);
		expect(await titles(t, contactA)).toEqual(['Survivor']);
		expect(await titles(t, contactB)).toEqual(['Survivor']);

		// Contact merge: B's rows move to C and keep answering.
		const contactC = await newContact(t);
		await t.run((ctx) => repointContactJunction(ctx, KNOWLEDGE_ENTRY_JUNCTION, contactC, contactB));
		expect(await titles(t, contactB)).toEqual([]);
		expect(await titles(t, contactC)).toEqual(['Survivor']);
	});

	it('backfill marks an orphan row not-open so the reader never hydrates it', async () => {
		const t = convexTest(schema, modules);
		// The public knowledge functions follow the `ai.knowledge` flag.
		await enableFeatures(t, ['ai.knowledge']);
		const contactId = await newContact(t);
		const rowId = await t.run(async (ctx) => {
			const entryId = await insertLegacy(ctx, contactId, {
				entryType: 'action_item',
				title: 'Gone',
			});
			await ctx.db.delete(entryId);
			return (await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_entry', (q) => q.eq('entryId', entryId))
				.unique())!._id;
		});
		expect(await titles(t, contactId)).toEqual([]);
		expect((await backfill(t)).projected).toBe(1);
		const row = await t.run((ctx) => ctx.db.get(rowId));
		expect(row?.isOpenCommitment).toBe(false);
	});
});
