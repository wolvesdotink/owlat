/**
 * Migration 0053 (project open-commitment facets) keeps its progress and
 * completion in the migration ledger (`migrationRuns`): one row whose cursor
 * and counts move in the same transaction as each page, marked completed by
 * the final page. A second `run` resumes from that cursor, and a run on a
 * finished migration does nothing unless asked to restart.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Doc } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModules';
import { createTestContact } from '../../__tests__/factories';

type Harness = TestConvex<typeof schema>;

const MIGRATION = '0053_project_open_commitments';
const migration = internal.migrations['0053_project_open_commitments'];
/** Two full pages of 100 and a partial third. */
const ROWS = 250;

/** Junction rows as written before the projection existed: no facets. */
async function seedLegacyRows(t: Harness, count: number): Promise<void> {
	await t.run(async (ctx) => {
		const contactId = await ctx.db.insert('contacts', createTestContact());
		for (let i = 0; i < count; i++) {
			const entryId = await ctx.db.insert('knowledgeEntries', {
				entryType: i % 2 === 0 ? 'action_item' : 'fact',
				title: `Entry ${i}`,
				content: 'Content',
				sourceType: 'agent_extracted',
				contactIds: [contactId],
				embedding: [],
				confidence: 0.8,
				lastValidatedAt: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('knowledgeEntryContacts', { entryId, contactId });
		}
	});
}

function ledger(t: Harness): Promise<Doc<'migrationRuns'> | null> {
	return t.run((ctx) =>
		ctx.db
			.query('migrationRuns')
			.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
			.unique()
	);
}

function unprojectedCount(t: Harness): Promise<number> {
	return t.run(async (ctx) => {
		const rows = await ctx.db.query('knowledgeEntryContacts').collect();
		return rows.filter((r) => r.isOpenCommitment === undefined).length;
	});
}

function drain(t: Harness): Promise<void> {
	return t.finishAllScheduledFunctions(vi.runAllTimers);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(Date.UTC(2026, 0, 1));
});
afterEach(() => vi.useRealTimers());

describe('migration 0053 ledger', () => {
	it('records cursor and counts with each page and marks the final page complete', async () => {
		const t = convexTest(schema, modules);
		await seedLegacyRows(t, ROWS);

		const started = await t.mutation(migration.run, {});
		expect(started).toEqual({ started: true, generation: 1 });
		const begun = await ledger(t);
		expect(begun).toMatchObject({
			introducedIn: '0.6.6',
			status: 'running',
			generation: 1,
			pageCount: 0,
			scannedCount: 0,
			changedCount: 0,
		});
		expect(begun?.cursor).toBeUndefined();
		expect(begun?.completedAt).toBeUndefined();

		// One page of the run, committed on its own: the ledger moves with it.
		vi.setSystemTime(Date.now() + 1_000);
		const first = await t.mutation(migration.projectPage, { cursor: null, generation: 1 });
		expect(first).toMatchObject({ isDone: false, scanned: 100, projected: 100 });
		const afterFirst = await ledger(t);
		expect(afterFirst).toMatchObject({
			status: 'running',
			cursor: first.cursor,
			pageCount: 1,
			scannedCount: 100,
			changedCount: 100,
			updatedAt: Date.now(),
		});
		expect(afterFirst?.completedAt).toBeUndefined();
		expect(await unprojectedCount(t)).toBe(ROWS - 100);

		// The scheduled chain then walks the whole table; its first page redoes
		// the one above (idempotent: it changes nothing) and records it again.
		vi.setSystemTime(Date.now() + 1_000);
		await drain(t);
		const done = await ledger(t);
		expect(done).toMatchObject({
			status: 'completed',
			generation: 1,
			pageCount: 4,
			scannedCount: 100 + ROWS,
			changedCount: ROWS,
			startedAt: begun?.startedAt,
		});
		expect(done?.completedAt).toBeGreaterThan(done!.startedAt);
		expect(await unprojectedCount(t)).toBe(0);
	});

	it('resumes an interrupted pass from the recorded cursor and drops the stale chain', async () => {
		const t = convexTest(schema, modules);
		await seedLegacyRows(t, ROWS);

		await t.mutation(migration.run, {});
		// The first page commits, then the chain dies before the next page runs.
		await t.mutation(migration.projectPage, { cursor: null, generation: 1 });
		const interrupted = await ledger(t);
		expect(interrupted).toMatchObject({ status: 'running', pageCount: 1, scannedCount: 100 });

		// The operator runs it again: same pass, next generation, stored cursor.
		const resumed = await t.mutation(migration.run, {});
		expect(resumed).toEqual({ started: true, generation: 2 });
		expect(await ledger(t)).toMatchObject({
			generation: 2,
			cursor: interrupted?.cursor,
			pageCount: 1,
			startedAt: interrupted?.startedAt,
		});

		// The generation-1 page still queued from the first run is superseded.
		const stale = await t.mutation(migration.projectPage, {
			cursor: null,
			chain: true,
			generation: 1,
		});
		expect(stale).toMatchObject({ isSuperseded: true, scanned: 0, projected: 0 });

		await drain(t);
		// Had the resume started over, or the stale chain run, rows would be
		// scanned twice. Exactly the 150 rows after the cursor were added.
		expect(await ledger(t)).toMatchObject({
			status: 'completed',
			generation: 2,
			pageCount: 3,
			scannedCount: ROWS,
			changedCount: ROWS,
		});
		expect(await unprojectedCount(t)).toBe(0);
	});

	it('does nothing when run again after completion, and restarts only when asked', async () => {
		const t = convexTest(schema, modules);
		await seedLegacyRows(t, ROWS);
		await t.mutation(migration.run, {});
		await drain(t);
		const finished = await ledger(t);
		expect(finished?.status).toBe('completed');

		vi.setSystemTime(Date.now() + 60_000);
		const again = await t.mutation(migration.run, {});
		expect(again.started).toBe(false);
		await drain(t);
		expect(await ledger(t)).toEqual(finished);

		const restarted = await t.mutation(migration.run, { restart: true });
		expect(restarted).toEqual({ started: true, generation: 2 });
		await drain(t);
		const second = await ledger(t);
		expect(second).toMatchObject({
			status: 'completed',
			generation: 2,
			pageCount: 3,
			scannedCount: ROWS,
			// Every row already carries facets: a fresh pass changes nothing.
			changedCount: 0,
		});
		expect(second!.startedAt).toBeGreaterThan(finished!.startedAt);
	});

	it('adopts a chain scheduled in the ledger-less argument shape', async () => {
		const t = convexTest(schema, modules);
		await seedLegacyRows(t, ROWS);

		// `{ cursor, chain }` without a generation, as the first shape scheduled it.
		await t.mutation(migration.projectPage, { cursor: null, chain: true });
		await drain(t);
		expect(await ledger(t)).toMatchObject({
			status: 'completed',
			generation: 1,
			pageCount: 3,
			scannedCount: ROWS,
			changedCount: ROWS,
		});
		expect(await unprojectedCount(t)).toBe(0);

		// Once the ledger owns the migration, an old-shape page projects once and
		// stops without touching the record.
		const before = await ledger(t);
		const page = await t.mutation(migration.projectPage, { cursor: null, chain: true });
		expect(page).toMatchObject({ scanned: 100, projected: 0, isDone: false });
		await drain(t);
		expect(await ledger(t)).toEqual(before);
	});
});
