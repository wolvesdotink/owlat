/**
 * The derived-field drift sampler (`maintenance/derivedFields/sampler.ts`).
 *
 * Proven here:
 *   · a corrupted cache is repaired to the exact recount with one drift event,
 *     and a second check finds nothing to do;
 *   · a recount over its row budget, a deleted parent and an unknown field id
 *     write nothing;
 *   · ticks rotate through the parents in creation order, at most the sample
 *     size per field, and start over once the table is exhausted;
 *   · parents that share one creation time are each visited in turn;
 *   · a field whose rows are large picks its sample in pages that stay inside
 *     the transaction read limit;
 *   · a write between the pick and the check is part of the recount, not
 *     overwritten by a stale value;
 *   · nothing is sampled while a workspace deletion is running.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { openWorkspaceDeletionFence } from './helpers/workspaceDeletionFence';
import { withCreationTime } from './helpers/creationTimeSeam';
import { createTestTransactionalEmail } from './factories';

const modules = import.meta.glob('../**/*.*s');
type T = TestConvex<typeof schema>;

let warn: MockInstance;
let info: MockInstance;
beforeEach(() => {
	warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	info = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
});

function events(spy: MockInstance, name: string): Array<Record<string, unknown>> {
	return spy.mock.calls
		.map(([line]) => {
			try {
				return JSON.parse(String(line)) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter((line): line is Record<string, unknown> => line?.['event'] === name);
}

async function seedRoom(
	t: T,
	opts: { messages: number; deleted?: number; messageCount?: number; lastMessageAt?: number }
): Promise<{ roomId: Id<'chatRooms'>; newest: number }> {
	return await t.run(async (ctx) => {
		const createdAt = 1_000;
		const roomId = await ctx.db.insert('chatRooms', {
			kind: 'channel',
			name: 'general',
			normalizedName: 'general',
			visibility: 'public',
			createdBy: 'user-1',
			createdAt,
			updatedAt: createdAt,
			lastMessageAt: opts.lastMessageAt ?? createdAt,
			messageCount: opts.messageCount ?? 0,
		});
		let newest = createdAt;
		for (let i = 0; i < opts.messages; i++) {
			newest = createdAt + 10 * (i + 1);
			await ctx.db.insert('chatMessages', {
				roomId,
				authorId: 'user-1',
				text: `message ${i}`,
				createdAt: newest,
				...(i < (opts.deleted ?? 0) ? { deletedAt: newest + 1 } : {}),
			});
		}
		return { roomId, newest };
	});
}

const check = (t: T, fieldId: string, parentId: string, extra: { maxSourceRows?: number } = {}) =>
	t.mutation(internal.maintenance.derivedFields.sampler.checkParent, {
		fieldId,
		parentId,
		...extra,
	});

const room = (t: T, id: Id<'chatRooms'>) => t.run((ctx) => ctx.db.get(id));

describe('checkParent', () => {
	it('repairs a drifted cache to the recount once, and logs it once', async () => {
		const t = convexTest(schema, modules);
		// Soft-deleted messages keep their row, so they still count.
		const { roomId, newest } = await seedRoom(t, {
			messages: 3,
			deleted: 1,
			messageCount: 7,
			lastMessageAt: 5,
		});

		expect(await check(t, 'chatRoomActivity', roomId)).toBe('repaired');
		expect(await room(t, roomId)).toMatchObject({ messageCount: 3, lastMessageAt: newest });
		const drift = events(warn, 'derived_field.drift');
		expect(drift).toHaveLength(1);
		expect(drift[0]).toMatchObject({
			level: 'warn',
			outcome: 'repaired',
			detail: expect.objectContaining({
				field: 'chatRoomActivity',
				table: 'chatRooms',
				parentId: roomId,
				drifted: 'messageCount,lastMessageAt',
				'cached.messageCount': 7,
				'recount.messageCount': 3,
			}),
		});

		expect(await check(t, 'chatRoomActivity', roomId)).toBe('clean');
		expect(events(warn, 'derived_field.drift')).toHaveLength(1);
	});

	it('keeps an empty room’s creation stamp: no message records another one', async () => {
		const t = convexTest(schema, modules);
		const { roomId } = await seedRoom(t, { messages: 0, messageCount: 2, lastMessageAt: 1_000 });
		expect(await check(t, 'chatRoomActivity', roomId)).toBe('repaired');
		expect(await room(t, roomId)).toMatchObject({ messageCount: 0, lastMessageAt: 1_000 });
	});

	it('skips a parent whose recount outruns the budget, writing nothing', async () => {
		const t = convexTest(schema, modules);
		const { roomId } = await seedRoom(t, { messages: 4, messageCount: 99 });
		const before = await room(t, roomId);

		expect(await check(t, 'chatRoomActivity', roomId, { maxSourceRows: 3 })).toBe('skipped');
		expect(await room(t, roomId)).toEqual(before);
		expect(events(warn, 'derived_field.drift')).toHaveLength(0);
		expect(events(info, 'derived_field.skipped')).toEqual([
			expect.objectContaining({
				outcome: 'over_budget',
				detail: expect.objectContaining({ field: 'chatRoomActivity', sourceRowsRead: 4 }),
			}),
		]);
		// The same parent fits a budget of its size exactly.
		expect(await check(t, 'chatRoomActivity', roomId, { maxSourceRows: 4 })).toBe('repaired');
	});

	it('does nothing for a deleted parent, a foreign id or an unknown field', async () => {
		const t = convexTest(schema, modules);
		const { roomId } = await seedRoom(t, { messages: 1, messageCount: 5 });
		await t.run((ctx) => ctx.db.delete(roomId));
		expect(await check(t, 'chatRoomActivity', roomId)).toBe('missing');
		expect(await check(t, 'chatRoomActivity', 'not-an-id')).toBe('missing');
		expect(await check(t, 'noSuchField', roomId)).toBe('unknown_field');
		expect(events(warn, 'derived_field.drift')).toHaveLength(0);
	});
});

type CheckArgs = { fieldId: string; parentId: string };

/** Every check the sampler has scheduled so far, run or not, oldest first. */
const allChecks = async (t: T) =>
	(await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect()))
		.filter((job) => job.name === 'maintenance/derivedFields/sampler:checkParent')
		.map((job) => ({ jobId: job._id as string, ...(job.args[0] as CheckArgs) }));

async function drain(t: T): Promise<void> {
	vi.useFakeTimers();
	try {
		await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1));
	} finally {
		vi.useRealTimers();
	}
}

/** Run one tick to the end and return the checks it scheduled. */
async function tick(t: T, args: { sampleSize?: number } = {}): Promise<CheckArgs[]> {
	const before = new Set((await allChecks(t)).map((job) => job.jobId));
	await t.mutation(internal.maintenance.derivedFields.sampler.sampleAll, args);
	await drain(t);
	return (await allChecks(t))
		.filter((job) => !before.has(job.jobId))
		.map(({ fieldId, parentId }) => ({ fieldId, parentId }));
}

const cursorOf = (t: T, fieldId: string) =>
	t.run((ctx) =>
		ctx.db
			.query('derivedFieldCursors')
			.withIndex('by_field_id', (q) => q.eq('fieldId', fieldId))
			.unique()
	);

function insertRooms(t: T, count: number, messageCount: number): Promise<Id<'chatRooms'>[]> {
	return t.run(async (ctx) => {
		const ids: Id<'chatRooms'>[] = [];
		for (let i = 0; i < count; i++) {
			ids.push(
				await ctx.db.insert('chatRooms', {
					kind: 'channel',
					name: `room${i}`,
					normalizedName: `room${i}`,
					visibility: 'public',
					createdBy: 'user-1',
					createdAt: 1_000,
					updatedAt: 1_000,
					lastMessageAt: 1_000,
					messageCount,
				})
			);
		}
		return ids;
	});
}

describe('sampleAll', () => {
	it('rotates through every parent in turn, at most the sample size per tick', async () => {
		const t = convexTest(schema, modules);
		const rooms: string[] = [];
		for (let i = 0; i < 5; i++) rooms.push((await seedRoom(t, { messages: 0 })).roomId);

		const ticks: string[][] = [];
		for (let i = 0; i < 4; i++) {
			const picked = await tick(t, { sampleSize: 2 });
			expect(picked.every((job) => job.fieldId === 'chatRoomActivity')).toBe(true);
			ticks.push(picked.map((job) => job.parentId));
		}

		expect(ticks).toEqual([
			[rooms[0], rooms[1]],
			[rooms[2], rooms[3]],
			[rooms[4]],
			[rooms[0], rooms[1]],
		]);
		expect(await cursorOf(t, 'chatRoomActivity')).toMatchObject({ rotations: 1, sampledCount: 7 });
	});

	it('visits every parent that shares one creation time', async () => {
		const t = convexTest(schema, modules);
		// Rows written in the same millisecond tie on `_creationTime`.
		const rooms = await withCreationTime(1_000, () => insertRooms(t, 5, 9));

		const ticks: string[][] = [];
		for (let i = 0; i < 3; i++) {
			ticks.push((await tick(t, { sampleSize: 2 })).map((job) => job.parentId));
		}

		expect(ticks.flat().sort()).toEqual([...rooms].sort());
		const counts = await t.run(async (ctx) =>
			Promise.all(rooms.map(async (id) => (await ctx.db.get(id))?.messageCount))
		);
		expect(counts).toEqual([0, 0, 0, 0, 0]);
		expect(await cursorOf(t, 'chatRoomActivity')).toMatchObject({ rotations: 1, sampledCount: 5 });
	});

	it('picks a sample of large parents inside the transaction read limit', async () => {
		// Enforces Convex's per-transaction limits, 16 MiB of reads among them.
		const t = convexTest({ schema, modules, transactionLimits: true }) as T;
		const content = 'x'.repeat(900_000);
		// 20 rows of ~900 KB: one page of the whole sample would read past 16 MiB.
		const emails: string[] = [];
		for (let i = 0; i < 20; i++) {
			emails.push(
				await t.run((ctx) =>
					ctx.db.insert('transactionalEmails', createTestTransactionalEmail({ content }))
				)
			);
		}

		const picked = await tick(t, { sampleSize: 20 });
		// The byte bound cuts a page at the fifth row (4.5 MB); the cut page is
		// retried at two rows, the next page is cut again, and the last of the
		// tick's four pages picks two more.
		expect(
			picked
				.filter((job) => job.fieldId === 'transactionalTemplateSends')
				.map((job) => job.parentId)
		).toEqual(emails.slice(0, 4));
		expect(events(info, 'derived_field.sampled')).toContainEqual(
			expect.objectContaining({
				detail: expect.objectContaining({ field: 'transactionalTemplateSends', pagesRead: 4 }),
			})
		);
		// The next tick goes on from the fifth row.
		const next = await tick(t, { sampleSize: 20 });
		expect(next.filter((job) => job.fieldId === 'transactionalTemplateSends')[0]?.parentId).toBe(
			emails[4]
		);
	});

	it('counts a write that lands between the pick and the check', async () => {
		const t = convexTest(schema, modules);
		const { roomId } = await seedRoom(t, { messages: 2, messageCount: 9 });
		await t.mutation(internal.maintenance.derivedFields.sampler.samplePage, {
			fieldId: 'chatRoomActivity',
			remaining: 5,
			pageRows: 5,
			pagesLeft: 1,
		});
		const pending = (await allChecks(t)).map(({ fieldId, parentId }) => ({ fieldId, parentId }));
		expect(pending).toEqual([{ fieldId: 'chatRoomActivity', parentId: roomId }]);

		// The writer posts a message after the pick, bumping the (still wrong) cache.
		const lastAt = await t.run(async (ctx) => {
			const at = 50_000;
			await ctx.db.insert('chatMessages', { roomId, authorId: 'u', text: 'late', createdAt: at });
			const current = await ctx.db.get(roomId);
			await ctx.db.patch(roomId, { messageCount: current!.messageCount + 1, lastMessageAt: at });
			return at;
		});
		await drain(t);

		expect(await room(t, roomId)).toMatchObject({ messageCount: 3, lastMessageAt: lastAt });
	});

	it('samples nothing while a workspace deletion runs', async () => {
		const t = convexTest(schema, modules);
		await seedRoom(t, { messages: 0, messageCount: 4 });
		await t.run((ctx) => openWorkspaceDeletionFence(ctx));
		expect(await t.mutation(internal.maintenance.derivedFields.sampler.sampleAll, {})).toEqual({
			fields: 0,
		});
		// A page chained before the deletion started stops too.
		await t.mutation(internal.maintenance.derivedFields.sampler.samplePage, {
			fieldId: 'chatRoomActivity',
			remaining: 5,
			pageRows: 5,
			pagesLeft: 1,
		});
		expect(await allChecks(t)).toEqual([]);
	});
});
