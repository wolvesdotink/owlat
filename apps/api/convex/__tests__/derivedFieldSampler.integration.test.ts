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
 *   · a write between the pick and the check is part of the recount, not
 *     overwritten by a stale value;
 *   · nothing is sampled while a workspace deletion is running.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { openWorkspaceDeletionFence } from './helpers/workspaceDeletionFence';

const modules = import.meta.glob('../**/*.*s');
type T = ReturnType<typeof convexTest>;

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

const scheduledChecks = async (t: T) =>
	(await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect()))
		.filter(
			(job) =>
				job.name === 'maintenance/derivedFields/sampler:checkParent' && job.state.kind === 'pending'
		)
		.map((job) => job.args[0] as { fieldId: string; parentId: string });

async function drain(t: T): Promise<void> {
	vi.useFakeTimers();
	try {
		await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1));
	} finally {
		vi.useRealTimers();
	}
}

describe('sampleAll', () => {
	it('rotates through every parent in turn, at most the sample size per tick', async () => {
		const t = convexTest(schema, modules);
		const rooms: string[] = [];
		for (let i = 0; i < 5; i++) rooms.push((await seedRoom(t, { messages: 0 })).roomId);

		const ticks: string[][] = [];
		for (let tick = 0; tick < 4; tick++) {
			await t.mutation(internal.maintenance.derivedFields.sampler.sampleAll, { sampleSize: 2 });
			const picked = await scheduledChecks(t);
			expect(picked.every((job) => job.fieldId === 'chatRoomActivity')).toBe(true);
			ticks.push(picked.map((job) => job.parentId));
			await drain(t);
		}

		expect(ticks).toEqual([
			[rooms[0], rooms[1]],
			[rooms[2], rooms[3]],
			[rooms[4]],
			[rooms[0], rooms[1]],
		]);
		const cursor = await t.run((ctx) =>
			ctx.db
				.query('derivedFieldCursors')
				.withIndex('by_field_id', (q) => q.eq('fieldId', 'chatRoomActivity'))
				.unique()
		);
		expect(cursor).toMatchObject({ rotations: 1, sampledCount: 7 });
	});

	it('counts a write that lands between the pick and the check', async () => {
		const t = convexTest(schema, modules);
		const { roomId } = await seedRoom(t, { messages: 2, messageCount: 9 });
		await t.mutation(internal.maintenance.derivedFields.sampler.sampleAll, {});
		expect(await scheduledChecks(t)).toEqual([{ fieldId: 'chatRoomActivity', parentId: roomId }]);

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
			scheduled: 0,
		});
		expect(await scheduledChecks(t)).toEqual([]);
	});
});
