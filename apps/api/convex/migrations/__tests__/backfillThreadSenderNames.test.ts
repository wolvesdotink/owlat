/**
 * Migration 0070: a conversation row stored before threads carried the latest
 * sender's display name gets it from the thread's newest message. A thread
 * that already has a name, and one whose newest message has none, is left
 * alone.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	modules,
	seedFolder,
	seedMailbox,
	seedMessage,
} from '../../mail/__tests__/helpers.testlib';
import { MIGRATION, PAGE_SIZE } from '../0070_backfill_thread_sender_names';

const migration = internal.migrations[MIGRATION];
type T = TestConvex<typeof schema>;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

/** A one-message thread whose row points at its message, as a delivery leaves it. */
async function seedThread(
	t: T,
	mailboxId: Id<'mailboxes'>,
	seed: { subject: string; fromName?: string }
): Promise<Id<'mailThreads'>> {
	const messageId = await seedMessage(t, mailboxId, seed);
	return await t.run(async (ctx) => {
		const { threadId } = (await ctx.db.get(messageId))!;
		await ctx.db.patch(threadId, { latestMessageId: messageId });
		return threadId;
	});
}

describe('0070_backfill_thread_sender_names', () => {
	it("fills the name from each thread's newest message, over several pages", async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const named = await seedThread(t, mailboxId, { subject: 'named', fromName: 'Ben Ortiz' });
		const bare = await seedThread(t, mailboxId, { subject: 'bare' });
		const kept = await seedThread(t, mailboxId, { subject: 'kept', fromName: 'Old Name' });
		await t.run((ctx) => ctx.db.patch(kept, { latestFromName: 'Ben O.' }));
		for (let i = 0; i < PAGE_SIZE; i++) {
			await seedThread(t, mailboxId, { subject: `plain ${i}`, fromName: `Sender ${i}` });
		}
		const bareBefore = await t.run(async (ctx) => (await ctx.db.get(bare))!);

		await t.mutation(migration.run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		await t.run(async (ctx) => {
			expect((await ctx.db.get(named))!.latestFromName).toBe('Ben Ortiz');
			expect((await ctx.db.get(kept))!.latestFromName).toBe('Ben O.');
			// Nothing to fill: the row is not written.
			expect(await ctx.db.get(bare)).toEqual(bareBefore);

			const run = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.unique();
			expect(run).toMatchObject({ status: 'completed', changedCount: PAGE_SIZE + 1 });
			expect(run!.pageCount).toBeGreaterThan(1);
		});

		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
	});
});
