/**
 * Migration 0055 (repair repeated Block and accordion-section ids) walks
 * `emailTemplates`, then `transactionalEmails`, and writes only the rows that
 * repeat an id: content and overlays together, the next content revision and
 * the stale-HTML flag, with the rows queued on the saved-block rerender pool.
 * Progress and completion live in the migration ledger.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { childBlockLists, ownedEntries, type BlockTreeNode } from '@owlat/shared/blockTree';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModules';
import { createTestEmailTemplate, createTestTransactionalEmail } from '../../__tests__/factories';
import { rerenderBlocksPool } from '../../emailBlocks/renderingPool';

// The workpool component is not registered in convex-test, and the queued
// action renders in Node; the queue call itself is what this suite checks.
vi.mock('../../emailBlocks/renderingPool', async () => {
	const actual = await vi.importActual('../../emailBlocks/renderingPool');
	return { ...actual, rerenderBlocksPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) } };
});

type Harness = TestConvex<typeof schema>;

const MIGRATION = '0055_repair_repeated_block_ids';
const migration = internal.migrations['0055_repair_repeated_block_ids'];

const text = (id: string, html = '<p>Hello</p>') => ({
	id,
	type: 'text',
	content: { html, blockType: 'paragraph', fontSize: 14, textColor: '#000000' },
});
const container = (id: string, items: unknown[]) => ({ id, type: 'container', content: { items } });
const hero = (id: string, items: unknown[]) => ({ id, type: 'hero', content: { items } });
const accordion = (id: string, prefix: string) => ({
	id,
	type: 'accordion',
	content: {
		sections: [
			{ id: 's1', title: 'One', items: [text(`${prefix}1`)] },
			{ id: 's2', title: 'Two', items: [] },
		],
	},
});

/** A duplicated Hero holding a Container, saved before descendant ids were renewed. */
const nestedCopies = JSON.stringify([
	hero('hero', [container('box', [text('t1')])]),
	hero('hero-copy', [container('box', [text('t1')])]),
]);
const accordionCopies = JSON.stringify([accordion('acc', 'a'), accordion('acc-copy', 'b')]);
const uniqueIds = JSON.stringify([container('solo', [text('only')])]);
const germanOverlay = JSON.stringify({
	de: { subject: 'Hallo', blocks: { t1: { html: '<p>Hallo</p>' } } },
});

function allIds(content: string): { blocks: string[]; sections: string[] } {
	const blocks: string[] = [];
	const sections: string[] = [];
	const visit = (node: BlockTreeNode): void => {
		blocks.push(node.id);
		for (const entry of ownedEntries(node)) sections.push(entry['id'] as string);
		for (const list of childBlockLists(node)) for (const child of list) visit(child);
	};
	for (const root of JSON.parse(content) as BlockTreeNode[]) visit(root);
	return { blocks, sections };
}

const isUnique = (ids: string[]) => new Set(ids).size === ids.length;

async function seed(t: Harness) {
	return await t.run(async (ctx) => {
		const nestedTemplate = await ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				content: nestedCopies,
				translations: germanOverlay,
				contentRevision: 4,
			})
		);
		const accordionTemplate = await ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({ content: accordionCopies, status: 'published' })
		);
		const cleanTemplate = await ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({ content: uniqueIds, translations: germanOverlay })
		);
		const nestedTransactional = await ctx.db.insert(
			'transactionalEmails',
			createTestTransactionalEmail({ content: nestedCopies, translations: germanOverlay })
		);
		const accordionTransactional = await ctx.db.insert(
			'transactionalEmails',
			createTestTransactionalEmail({ slug: 'receipt-two', content: accordionCopies })
		);
		const cleanTransactional = await ctx.db.insert(
			'transactionalEmails',
			createTestTransactionalEmail({ slug: 'clean', content: uniqueIds })
		);
		return {
			nestedTemplate,
			accordionTemplate,
			cleanTemplate,
			nestedTransactional,
			accordionTransactional,
			cleanTransactional,
		};
	});
}

function get<T extends 'emailTemplates' | 'transactionalEmails'>(
	t: Harness,
	id: Id<T>
): Promise<Doc<T> | null> {
	return t.run((ctx) => ctx.db.get(id));
}

function ledger(t: Harness): Promise<Doc<'migrationRuns'> | null> {
	return t.run((ctx) =>
		ctx.db
			.query('migrationRuns')
			.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
			.unique()
	);
}

function drain(t: Harness): Promise<void> {
	return t.finishAllScheduledFunctions(vi.runAllTimers);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(Date.UTC(2026, 9, 1));
	vi.mocked(rerenderBlocksPool.enqueueAction).mockClear();
});
afterEach(() => vi.useRealTimers());

describe('migration 0055', () => {
	it('repairs templates and transactional emails, nested composites and accordion sections', async () => {
		const t = convexTest(schema, modules);
		const ids = await seed(t);
		const cleanBefore = {
			template: await get(t, ids.cleanTemplate),
			transactional: await get(t, ids.cleanTransactional),
		};

		expect(await t.mutation(migration.run, {})).toEqual({ started: true, generation: 1 });
		await drain(t);

		for (const id of [ids.nestedTemplate, ids.nestedTransactional] as const) {
			const row = (await get(t, id))!;
			const { blocks } = allIds(row.content);
			expect(isUnique(blocks)).toBe(true);
			// The first copy keeps its ids; the second copy's Container and text are new.
			expect(blocks.slice(0, 3)).toEqual(['hero', 'box', 't1']);
			const copyText = blocks[5]!;
			const overlay = JSON.parse(row.translations!) as {
				de: { blocks: Record<string, { html: string }> };
			};
			expect(overlay.de.blocks).toEqual({
				t1: { html: '<p>Hallo</p>' },
				[copyText]: { html: '<p>Hallo</p>' },
			});
			expect(row.htmlRenderState).toEqual({ stale: true, failureCount: 0 });
		}
		expect((await get(t, ids.nestedTemplate))!.contentRevision).toBe(5);
		expect((await get(t, ids.nestedTransactional))!.contentRevision).toBe(1);

		for (const id of [ids.accordionTemplate, ids.accordionTransactional] as const) {
			const row = (await get(t, id))!;
			const { blocks, sections } = allIds(row.content);
			expect(isUnique(sections)).toBe(true);
			expect(sections.slice(0, 2)).toEqual(['s1', 's2']);
			expect(isUnique(blocks)).toBe(true);
			expect(row.translations).toBeUndefined();
		}
		// A published row is repaired too: its sent HTML is what had the defect.
		expect((await get(t, ids.accordionTemplate))!.status).toBe('published');

		// Rows without a repeated id are not written.
		expect(await get(t, ids.cleanTemplate)).toEqual(cleanBefore.template);
		expect(await get(t, ids.cleanTransactional)).toEqual(cleanBefore.transactional);

		// Each table's repaired rows are queued for the HTML rerender.
		const queued = vi.mocked(rerenderBlocksPool.enqueueAction).mock.calls.map((call) => call[2]);
		expect(queued).toEqual([
			{ templateIds: [ids.nestedTemplate, ids.accordionTemplate], transactionalIds: [] },
			{ templateIds: [], transactionalIds: [ids.nestedTransactional, ids.accordionTransactional] },
		]);

		expect(await ledger(t)).toMatchObject({
			status: 'completed',
			introducedIn: '0.6.7',
			pageCount: 2,
			scannedCount: 6,
			changedCount: 4,
		});
	});

	it('pages through both tables, resumes from the ledger, and writes nothing on a second pass', async () => {
		const t = convexTest(schema, modules);
		const ids = await seed(t);
		// Enough clean rows for several pages per table.
		await t.run(async (ctx) => {
			for (let i = 0; i < 25; i++) {
				await ctx.db.insert('emailTemplates', createTestEmailTemplate({ content: uniqueIds }));
				await ctx.db.insert(
					'transactionalEmails',
					createTestTransactionalEmail({ slug: `clean-${i}`, content: uniqueIds })
				);
			}
		});

		await t.mutation(migration.run, {});
		// One page commits, then the chain dies.
		const first = await t.mutation(migration.repairPage, {
			table: 'emailTemplates',
			cursor: null,
			generation: 1,
		});
		expect(first).toMatchObject({ isDone: false, scanned: 10 });
		expect(first.cursor.startsWith('emailTemplates:')).toBe(true);

		// Run again: next generation, from the stored cursor; the old chain is dropped.
		expect(await t.mutation(migration.run, {})).toEqual({ started: true, generation: 2 });
		const stale = await t.mutation(migration.repairPage, {
			table: 'emailTemplates',
			cursor: null,
			generation: 1,
		});
		expect(stale).toMatchObject({ isSuperseded: true, scanned: 0, repaired: 0 });
		await drain(t);

		// 28 rows per table, each scanned once: the resume continued after the
		// committed page instead of starting over.
		const done = await ledger(t);
		expect(done).toMatchObject({ status: 'completed', generation: 2, scannedCount: 56 });
		expect(done!.changedCount).toBe(4);
		const repaired = (await get(t, ids.nestedTemplate))!;

		// A fresh pass finds nothing left to repair.
		vi.setSystemTime(Date.now() + 60_000);
		expect((await t.mutation(migration.run, {})).started).toBe(false);
		await t.mutation(migration.run, { restart: true });
		await drain(t);
		expect(await ledger(t)).toMatchObject({
			status: 'completed',
			scannedCount: 56,
			changedCount: 0,
		});
		expect(await get(t, ids.nestedTemplate)).toEqual(repaired);
	});

	it('leaves a row with unreadable overlays as it is', async () => {
		const t = convexTest(schema, modules);
		const id = await t.run((ctx) =>
			ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({ content: nestedCopies, translations: '{not json' })
			)
		);
		const before = await get(t, id);
		await t.mutation(migration.run, {});
		await drain(t);
		expect(await get(t, id)).toEqual(before);
		expect(await ledger(t)).toMatchObject({ status: 'completed', changedCount: 0 });
	});
});
