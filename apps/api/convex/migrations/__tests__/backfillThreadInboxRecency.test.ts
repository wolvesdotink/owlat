/**
 * Migration 0073: a thread stored before `inboxLastMessageAt` existed gets its
 * `lastMessageAt` when it is in the Inbox and `null` when it is not; a thread
 * whose value is already right is not written. The conversation list reads
 * the Inbox index only once the ledger row says the walk completed.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { modules, seedMailbox } from '../../mail/__tests__/helpers.testlib';
import { isInboxRecencyIndexReady } from '../../mail/threadInboxRecency';
import { MIGRATION, PAGE_SIZE } from '../0073_backfill_thread_inbox_recency';

const migration = internal.migrations[MIGRATION];
type T = TestConvex<typeof schema>;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function seedThread(
	t: T,
	mailboxId: Id<'mailboxes'>,
	seed: { folderRoles: string[]; lastMessageAt: number; inboxLastMessageAt?: number | null }
): Promise<Id<'mailThreads'>> {
	return await t.run((ctx) =>
		ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'hi',
			participants: ['a@example.com'],
			messageCount: 1,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			firstMessageAt: seed.lastMessageAt,
			latestSnippet: '',
			latestFromAddress: 'a@example.com',
			latestSubject: 'hi',
			labelIds: [],
			createdAt: seed.lastMessageAt,
			updatedAt: seed.lastMessageAt,
			...seed,
		})
	);
}

describe('0073_backfill_thread_inbox_recency', () => {
	it('sets the Inbox recency on every thread, over several pages, then opens the index', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const inbox = await seedThread(t, mailboxId, {
			folderRoles: ['inbox', 'sent'],
			lastMessageAt: 1_000,
		});
		const archived = await seedThread(t, mailboxId, {
			folderRoles: ['archive'],
			lastMessageAt: 2_000,
		});
		const right = await seedThread(t, mailboxId, {
			folderRoles: ['inbox'],
			lastMessageAt: 3_000,
			inboxLastMessageAt: 3_000,
		});
		for (let i = 0; i < PAGE_SIZE; i++) {
			await seedThread(t, mailboxId, { folderRoles: ['sent'], lastMessageAt: 4_000 + i });
		}
		const rightBefore = await t.run(async (ctx) => (await ctx.db.get(right))!);
		expect(await t.run((ctx) => isInboxRecencyIndexReady(ctx))).toBe(false);

		await t.mutation(migration.run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		await t.run(async (ctx) => {
			expect((await ctx.db.get(inbox))!.inboxLastMessageAt).toBe(1_000);
			expect((await ctx.db.get(archived))!.inboxLastMessageAt).toBeNull();
			expect(await ctx.db.get(right)).toEqual(rightBefore);

			const run = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.unique();
			expect(run).toMatchObject({ status: 'completed', changedCount: PAGE_SIZE + 2 });
			expect(run!.pageCount).toBeGreaterThan(1);
			expect(await isInboxRecencyIndexReady(ctx)).toBe(true);
		});

		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
	});
});
