/**
 * Re-runs of the operator-run migrations that predate the ledger.
 *
 * Their `run` actions commit one page, scope or thread at a time, so a run that
 * dies part-way leaves the earlier commits in place and the operator runs it
 * again. These tests pin what that relies on: what a commit left behind is
 * not redone on the next run, and a re-run after an interrupted walk ends where
 * one clean run would.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModules';
import { seedFolder, seedMailbox, seedMessage } from '../../mail/__tests__/helpers.testlib';

type T = TestConvex<typeof schema>;

// The runs schedule classifier and backfill jobs; with the clock faked they
// stay queued, so each test reads exactly what the run itself committed.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function scheduledNames(t: T): Promise<string[]> {
	return await t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect()).map((job) => job.name)
	);
}

async function seedInboxThread(t: T, mailboxId: Id<'mailboxes'>, subject: string) {
	const messageId = await seedMessage(t, mailboxId, { subject });
	const message = await t.run(async (ctx) => ctx.db.get(messageId));
	return { messageId, threadId: message!.threadId };
}

describe('0037 category backfill', () => {
	it('lists only threads still unclassified, so a re-run leaves the first run alone', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');
		const first = await seedInboxThread(t, mailboxId, 'first');
		const run = internal.migrations['0037_backfill_mail_categories'].run;

		expect(await t.action(run, { mailboxId })).toEqual({ scheduled: 1 });
		const firstCategory = await t.run(async (ctx) => (await ctx.db.get(first.threadId))?.category);
		expect(firstCategory).toBeDefined();

		// A thread that arrived unclassified after the first run is the only work left.
		const second = await seedInboxThread(t, mailboxId, 'second');
		expect(await t.action(run, { mailboxId })).toEqual({ scheduled: 1 });
		const categories = await t.run(async (ctx) => ({
			first: (await ctx.db.get(first.threadId))?.category,
			second: (await ctx.db.get(second.threadId))?.category,
		}));
		expect(categories.first).toEqual(firstCategory);
		expect(categories.second).toBeDefined();

		expect(await t.action(run, { mailboxId })).toEqual({ scheduled: 0 });
	});
});

describe('0045 needs-reply re-check', () => {
	it('keeps each requeued thread flagged and pending, so a re-run finds the same queue', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');
		const { messageId, threadId } = await seedInboxThread(t, mailboxId, 'flagged');
		await seedInboxThread(t, mailboxId, 'not flagged');
		const flag = { messageId, source: 'heuristic' as const, urgency: 'normal' as const };
		await t.run(async (ctx) => {
			await ctx.db.patch(threadId, { needsReply: { ...flag, detectedAt: 1 } });
		});
		const run = internal.migrations['0045_recheck_needs_reply'].run;
		const thread = () => t.run(async (ctx) => ctx.db.get(threadId));

		expect(await t.action(run, { mailboxId })).toEqual({ scheduled: 1 });
		expect((await thread())?.needsReply).toMatchObject(flag);
		expect((await thread())?.needsReplyPendingAt).toBeDefined();

		expect(await t.action(run, { mailboxId })).toEqual({ scheduled: 1 });
		expect((await thread())?.needsReply).toMatchObject(flag);
		// One classify job per run: the re-run re-queues the same thread, nothing more.
		const classifyJobs = (await scheduledNames(t)).filter((name) =>
			name.includes('needsReplyClassify')
		);
		expect(classifyJobs).toHaveLength(2);
	});
});

describe('0048 counter backfill', () => {
	async function scopeRows(t: T) {
		return await t.run(async (ctx) =>
			(await ctx.db.query('counterScopes').collect()).map((row) => row.scope).sort()
		);
	}

	it('starts each scope once; a re-run resumes the walking ones', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');
		const run = internal.migrations['0048_backfill_counters'].run;

		// Four instance-wide scopes, plus a label, section and arrivals scope per mailbox.
		expect(await t.action(run, {})).toEqual({ started: 7, running: 0, ready: 0 });
		const scopes = await scopeRows(t);
		expect(scopes).toHaveLength(7);

		expect(await t.action(run, {})).toEqual({ started: 0, running: 7, ready: 0 });
		expect(await scopeRows(t)).toEqual(scopes);
	});

	it('a rebuild re-run after an interrupted clear drops the rest and starts afresh', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');
		const migration = internal.migrations['0048_backfill_counters'];
		await t.action(migration.run, {});
		// More buckets than one clear batch takes.
		await t.run(async (ctx) => {
			for (let i = 0; i < 501; i++) {
				await ctx.db.insert('counterBuckets', {
					scope: `mailLabelUnread:${mailboxId}`,
					bucket: String(i).padStart(10, '0'),
					count: 1,
					updatedAt: 1,
				});
			}
		});

		// The interrupted rebuild got as far as one scope's first batch.
		expect(
			await t.mutation(migration.clearScope, {
				scope: { kind: 'mailLabelUnread', ownerId: mailboxId },
			})
		).toBe(true);
		expect(await scopeRows(t)).toHaveLength(6);

		expect(await t.action(migration.run, { rebuild: true })).toEqual({
			started: 7,
			running: 0,
			ready: 0,
		});
		expect(await scopeRows(t)).toHaveLength(7);
		const buckets = await t.run(async (ctx) => ctx.db.query('counterBuckets').collect());
		expect(buckets).toEqual([]);
	});
});
