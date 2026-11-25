/**
 * The tie-safe walk of a range that keeps its rows (`purgeDrain.ts
 * rowsAfterTied`), over each of its readers: a thread's items, facts and
 * messages. Many rows can share one creation time; a slice resumes inside
 * such a tie by seeking past the cursor's id, so the rows a walk fetches grow
 * with the range, never with the square of the tie.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../../_generated/dataModel';
import type { MutationCtx } from '../../../_generated/server';
import schema from '../../../schema';
import { withCreationTime } from '../../../__tests__/helpers/creationTimeSeam';
import {
	scanRange,
	tiedPositionOf,
	unitBudget,
	type DrainBudget,
	type PurgeCursor,
	type RangePosition,
} from '../purgeDrain';
import { factsAfter, itemsAfter } from '../purge';
import { messagesAfter } from '../scopeScan';
import { modules, seedMailThread, type Test } from './interpret.testlib';
import { insertFact, insertItem } from './purge.testlib';

interface Row {
	_id: string;
	_creationTime: number;
}

type Read = (
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	after: RangePosition | undefined,
	n: number,
	budget: DrainBudget
) => Promise<Row[]>;

interface Reader {
	name: string;
	read: Read;
	/** One more row of the thread's range. */
	insert(
		ctx: MutationCtx,
		threadId: Id<'mailThreads'>,
		messageId: Id<'mailMessages'>
	): Promise<string>;
	/** The thread's range in index order. */
	all(ctx: MutationCtx, threadId: Id<'mailThreads'>): Promise<Row[]>;
}

const source = (messageId: Id<'mailMessages'>) => [{ kind: 'mail' as const, id: messageId }];

const READERS: Reader[] = [
	{
		name: 'items',
		read: (ctx, threadId, after, n, budget) =>
			itemsAfter(ctx, { kind: 'mail', id: threadId }, after, n, budget),
		insert: (ctx, threadId, messageId) =>
			insertItem(ctx, { kind: 'mail', id: threadId }, source(messageId)),
		all: (ctx, threadId) =>
			ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.collect(),
	},
	{
		name: 'facts',
		read: factsAfter,
		insert: (ctx, threadId, messageId) => insertFact(ctx, threadId, source(messageId)),
		all: (ctx, threadId) =>
			ctx.db
				.query('threadFacts')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.collect(),
	},
	{
		name: 'messages',
		read: messagesAfter,
		insert: async (ctx, _threadId, messageId) => {
			const { _id, _creationTime, ...message } = (await ctx.db.get(messageId))!;
			return ctx.db.insert('mailMessages', message);
		},
		all: (ctx, threadId) =>
			ctx.db
				.query('mailMessages')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.collect(),
	},
];

interface Seeded {
	threadId: Id<'mailThreads'>;
	messageId: Id<'mailMessages'>;
	tieAt: number;
	tied: string[];
}

/** `before` rows, then `tie` rows at one creation time, then `after` rows. */
async function seedTie(
	t: Test,
	reader: Reader,
	counts: { before: number; tie: number; after: number }
): Promise<Seeded> {
	const { threadId, messageId } = await seedMailThread(t);
	const insertMany = (k: number) =>
		t.run(async (ctx) => {
			const ids: string[] = [];
			for (let i = 0; i < k; i++) ids.push(await reader.insert(ctx, threadId, messageId));
			return ids;
		});
	await insertMany(counts.before);
	const tieAt = await t.run(async (ctx) => {
		const rows = await reader.all(ctx, threadId);
		const message = (await ctx.db.get(messageId))!;
		return Math.max(message._creationTime, rows[rows.length - 1]?._creationTime ?? 0) + 1;
	});
	const tied = await withCreationTime(tieAt, () => insertMany(counts.tie));
	await insertMany(counts.after);
	return { threadId, messageId, tieAt, tied };
}

interface Walk {
	visits: string[];
	/** Every document the walk's reads fetched (each one is charged). */
	fetched: number;
	slices: number;
}

/**
 * Walk the range a slice of `rows` at a time, each slice its own transaction
 * as a job's would be. `between` runs after each slice with the cursor it left.
 */
async function walk(
	t: Test,
	reader: Reader,
	threadId: Id<'mailThreads'>,
	rows: number,
	opts: {
		cursor?: PurgeCursor;
		between?: (slice: number, cursor: PurgeCursor | undefined) => Promise<void>;
	} = {}
): Promise<Walk> {
	const visits: string[] = [];
	let fetched = 0;
	let cursor = opts.cursor;
	for (let slices = 1; ; slices++) {
		expect(slices).toBeLessThan(500);
		const outcome = await t.run(async (ctx) => {
			const inner = unitBudget(rows);
			const budget: DrainBudget = {
				...inner,
				charge: (doc) => {
					fetched += 1;
					inner.charge(doc);
				},
			};
			return scanRange(
				budget,
				cursor,
				(after, n) => reader.read(ctx, threadId, after, n, budget),
				tiedPositionOf,
				async (row) => {
					visits.push(row._id);
					return true;
				}
			);
		});
		if (outcome.isDone) return { visits, fetched, slices };
		cursor = outcome.cursor;
		await opts.between?.(slices, cursor);
	}
}

const SLICE_ROWS = 20;

describe.each(READERS)('rowsAfterTied over a thread’s $name', (reader) => {
	it('fetches rows in proportion to the tie, not to its square', async () => {
		async function fetchedFor(tie: number): Promise<number> {
			const t = convexTest(schema, modules);
			const { threadId } = await seedTie(t, reader, { before: 0, tie, after: 0 });
			const run = await walk(t, reader, threadId, SLICE_ROWS);
			expect(new Set(run.visits).size).toBe(run.visits.length);
			return run.fetched;
		}
		const small = await fetchedFor(60);
		const large = await fetchedFor(240);
		// Four times the tie, at most four times the reads. Re-reading the
		// tie's earlier part on every slice makes it about sixteen times.
		expect(large).toBeLessThanOrEqual(4 * small);
	});

	it('visits every row once across slices, around and inside a tie', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedTie(t, reader, { before: 3, tie: 3 * SLICE_ROWS, after: 3 });
		const run = await walk(t, reader, threadId, SLICE_ROWS);
		const range = await t.run((ctx) => reader.all(ctx, threadId));
		expect(run.slices).toBeGreaterThan(2);
		expect(run.visits).toEqual(range.map((row) => row._id));
	});

	it('visits a row inserted into the tie between slices once, if it sorts after the cursor', async () => {
		const t = convexTest(schema, modules);
		const { threadId, messageId, tieAt, tied } = await seedTie(t, reader, {
			before: 2,
			tie: 3 * SLICE_ROWS,
			after: 2,
		});
		let inserted: string | undefined;
		let isAfterCursor = false;
		const run = await walk(t, reader, threadId, SLICE_ROWS, {
			between: async (slice, cursor) => {
				if (slice !== 1) return;
				// The first slice stopped inside the tie.
				expect(cursor?.at).toBe(tieAt);
				inserted = await withCreationTime(tieAt, () =>
					t.run((ctx) => reader.insert(ctx, threadId, messageId))
				);
				const order = (await t.run((ctx) => reader.all(ctx, threadId))).map((row) => row._id);
				isAfterCursor = order.indexOf(inserted) > order.indexOf(cursor!.key!);
			},
		});
		const counts = new Map<string, number>();
		for (const id of run.visits) counts.set(id, (counts.get(id) ?? 0) + 1);
		const range = await t.run((ctx) => reader.all(ctx, threadId));
		for (const row of range) {
			if (row._id === inserted) continue;
			expect(counts.get(row._id)).toBe(1);
		}
		expect(tied.every((id) => counts.get(id) === 1)).toBe(true);
		expect(counts.get(inserted!) ?? 0).toBe(isAfterCursor ? 1 : 0);
	});
});

describe('a cursor stored before the seek', () => {
	const reader = READERS[0]!;

	it('resumes a creation time and id cursor right after that row', async () => {
		const t = convexTest(schema, modules);
		const { threadId, tieAt } = await seedTie(t, reader, { before: 2, tie: 30, after: 2 });
		const range = (await t.run((ctx) => reader.all(ctx, threadId))).map((row) => row._id);
		// The shape a job wrote mid-tie before the update: `{ at, key }`.
		const cursor = { at: tieAt, key: range[12]! };
		const run = await walk(t, reader, threadId, SLICE_ROWS, { cursor });
		expect(run.visits).toEqual(range.slice(13));
	});

	it('resumes after a cursor row the walk has since deleted', async () => {
		const t = convexTest(schema, modules);
		const { threadId, tieAt } = await seedTie(t, reader, { before: 2, tie: 30, after: 2 });
		const range = (await t.run((ctx) => reader.all(ctx, threadId))).map((row) => row._id);
		await t.run((ctx) => ctx.db.delete(range[12] as Id<'threadItems'>));
		const run = await walk(t, reader, threadId, SLICE_ROWS, {
			cursor: { at: tieAt, key: range[12]! },
		});
		expect(run.visits).toEqual(range.slice(13));
	});

	it('reads the whole creation time again from a creation-time-only cursor', async () => {
		const t = convexTest(schema, modules);
		const { threadId, tieAt } = await seedTie(t, reader, { before: 2, tie: 30, after: 2 });
		const range = (await t.run((ctx) => reader.all(ctx, threadId))).map((row) => row._id);
		const run = await walk(t, reader, threadId, SLICE_ROWS, { cursor: { at: tieAt } });
		expect(run.visits).toEqual(range.slice(2));
	});
});
