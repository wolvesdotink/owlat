/**
 * The Answer badge's Team Inbox count (`queries.countReviewQueue`), counted:
 * what it reads, and that it agrees with the list (`getReviewQueue`).
 *
 * Read from the messages it loads every queued row, body and draft included,
 * and each held row's thread. Read from the threads' counts
 * (`reviewQueueCount.ts`, once migration 0074 has counted the existing
 * messages) it loads one small thread row per thread with something queued.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { components, internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { modules, newBetterAuthHarness } from '../../__tests__/testModules';
import { observingDb } from '../../__tests__/indexRecorder.testlib';
import { _resetSingletonOrgCacheForTests } from '../../lib/sessionOrganization';
import { countReviewQueue, getReviewQueue } from '../queries';
import { transition } from '../processingLifecycle';
import { moveReviewQueueCount } from '../reviewQueueCount';
import {
	MIGRATION,
	PAGE_SIZE,
	RECOUNT_BYTES,
} from '../../migrations/0074_backfill_review_queue_counts';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

type T = ReturnType<typeof convexTest>;
type Handler<Args, Result> = { _handler: (ctx: unknown, args: Args) => Promise<Result> };
type Status = Doc<'inboundMessages'>['processingStatus'];
type ThreadStatus = Doc<'conversationThreads'>['status'];

const runCount = (countReviewQueue as unknown as Handler<{ limit?: number }, number>)._handler;
const runList = (getReviewQueue as unknown as Handler<{ limit?: number }, unknown[]>)._handler;
const runTransition = (transition as unknown as Handler<unknown, { ok: boolean }>)._handler;

async function seedThread(t: T, status: ThreadStatus = 'open') {
	return await t.run((ctx) =>
		ctx.db.insert('conversationThreads', {
			subject: 'Help',
			normalizedSubject: 'help',
			contactIdentifier: 'dana@example.com',
			status,
			messageCount: 1,
			lastMessageAt: 1,
			firstMessageAt: 1,
			createdAt: 1,
		})
	);
}

async function seedMessage(
	t: T,
	threadId: Id<'conversationThreads'> | undefined,
	processingStatus: Status,
	bodyBytes = 1024
) {
	return await t.run((ctx) =>
		ctx.db.insert('inboundMessages', {
			messageId: `<${Math.random()}@example.com>`,
			from: 'dana@example.com',
			to: 'support@owlat.app',
			subject: 'Help',
			textBody: 'x'.repeat(bodyBytes),
			processingStatus,
			receivedAt: 1,
			...(threadId ? { threadId } : {}),
			...(processingStatus === 'draft_ready' ? { draftResponse: 'Thanks, Dana' } : {}),
		})
	);
}

/** One message per thread: `drafts` waiting for review, `held` on the agent's questions. */
async function seedQueue(t: T, drafts: number, held: number, bodyBytes: number) {
	for (let i = 0; i < drafts + held; i++) {
		await seedMessage(
			t,
			await seedThread(t),
			i < drafts ? 'draft_ready' : 'awaiting_clarification',
			bodyBytes
		);
	}
}

async function backfill(t: T) {
	await t.mutation(internal.migrations[MIGRATION].run, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** The badge's number, with the inbound rows (and their bytes) and thread rows it read. */
async function badge(t: T, limit = 50) {
	const reads = { inbound: 0, inboundBytes: 0, threads: 0, threadGets: 0, inboundIds: new Set() };
	const count = await t.run((ctx) =>
		runCount(
			{
				...ctx,
				db: observingDb(ctx.db, {
					onRead(source, rows) {
						for (const row of rows) {
							if ('processingStatus' in row) {
								reads.inbound += 1;
								reads.inboundBytes += JSON.stringify(row).length;
								reads.inboundIds.add(row._id);
							} else if ('normalizedSubject' in row) {
								if (source === 'get') reads.threadGets += 1;
								else reads.threads += 1;
							}
						}
					},
				}),
			},
			{ limit }
		)
	);
	return { count, ...reads };
}

const listLength = async (t: T, limit = 50) =>
	(await t.run((ctx) => runList(ctx, { limit }))).length;

async function move(t: T, messageId: Id<'inboundMessages'>, input: Record<string, unknown>) {
	const outcome = await t.run((ctx) =>
		runTransition(ctx, { inboundMessageId: messageId, input: { at: Date.now(), ...input } })
	);
	expect(outcome.ok).toBe(true);
}

describe('the Answer badge reads threads, not queued messages', () => {
	it.each([1024, 200 * 1024])('20 drafts and 20 held questions, %i-byte bodies', async (size) => {
		const t = convexTest(schema, modules);
		await seedQueue(t, 20, 20, size);

		// Before the walk has counted the existing messages: the old read.
		const before = await badge(t);
		expect(before).toMatchObject({ count: 40, inbound: 40, threadGets: 20, threads: 0 });
		expect(before.inboundBytes).toBeGreaterThan(40 * size);

		await backfill(t);
		const after = await badge(t);
		expect(after).toMatchObject({
			count: 40,
			inbound: 0,
			inboundBytes: 0,
			threadGets: 0,
			threads: 40,
		});
		expect(await listLength(t)).toBe(40);
	});

	it('stops reading at the limit', async () => {
		const t = convexTest(schema, modules);
		await seedQueue(t, 30, 30, 1024);
		await backfill(t);

		expect(await badge(t, 10)).toMatchObject({ count: 10, inbound: 0, threads: 10 });
		expect(await listLength(t, 10)).toBe(10);
	});

	it('leaves out held questions on settled threads, as the list does', async () => {
		const t = convexTest(schema, modules);
		await seedQueue(t, 2, 2, 1024);
		// Settled conversations: one flagged, one a straggler the flag has not reached.
		await seedMessage(t, await seedThread(t, 'resolved'), 'awaiting_clarification');
		const closed = await seedThread(t, 'closed');
		const flagged = await seedMessage(t, closed, 'awaiting_clarification');
		await t.run((ctx) => ctx.db.patch(flagged, { isThreadSettled: true }));
		// A draft on a settled thread still waits for review.
		await seedMessage(t, closed, 'draft_ready');
		await backfill(t);

		expect((await badge(t)).count).toBe(5);
		expect(await listLength(t)).toBe(5);
	});

	it('counts queued messages that have no thread', async () => {
		const t = convexTest(schema, modules);
		await seedQueue(t, 1, 1, 1024);
		await seedMessage(t, undefined, 'draft_ready');
		await seedMessage(t, undefined, 'awaiting_clarification');
		await backfill(t);

		const after = await badge(t);
		expect(after).toMatchObject({ count: 4, inbound: 2, threads: 2 });
		expect(await listLength(t)).toBe(4);
	});
});

describe('the counts follow the queue', () => {
	it('moves with each status transition, and agrees with the list', async () => {
		// Holding a message notifies the shared-inbox readers, a BetterAuth read.
		_resetSingletonOrgCacheForTests();
		const t = newBetterAuthHarness();
		await t.mutation(components.betterAuth.adapter.create, {
			input: { model: 'organization', data: { name: 'Acme', slug: 'acme', createdAt: 1 } },
		} as never);
		await backfill(t);
		const threadId = await seedThread(t);
		const first = await seedMessage(t, threadId, 'drafting');
		const second = await seedMessage(t, threadId, 'drafting');

		await move(t, first, { to: 'draft_ready', draftResponse: 'Thanks, Dana' });
		await move(t, second, { to: 'awaiting_clarification' });
		expect((await badge(t)).count).toBe(2);
		expect(await listLength(t)).toBe(2);

		await move(t, first, { to: 'approved', source: 'human', userId: 'test-user' });
		expect((await badge(t)).count).toBe(1);
		expect(await listLength(t)).toBe(1);

		// The conversation settles: its held question needs nobody.
		await t.run((ctx) => ctx.db.patch(threadId, { status: 'resolved' }));
		expect((await badge(t)).count).toBe(0);
		expect(await listLength(t)).toBe(0);

		const thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread).toMatchObject({ reviewHeldCount: 1 });
		expect(thread?.reviewDraftCount).toBeUndefined();
	});

	it('reads no message, so a draft edit is no dependency of the badge', async () => {
		const t = convexTest(schema, modules);
		await seedQueue(t, 3, 3, 1024);
		await backfill(t);

		expect((await badge(t)).inboundIds.size).toBe(0);
	});

	it('drops a deleted message from its thread', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedThread(t);
		const messageId = await seedMessage(t, threadId, 'draft_ready');
		await seedMessage(t, threadId, 'draft_ready');
		await backfill(t);

		await t.run(async (ctx) => {
			await moveReviewQueueCount(ctx, threadId, 'draft_ready', null);
			await ctx.db.delete(messageId);
		});
		expect((await badge(t)).count).toBe(1);
		expect(await listLength(t)).toBe(1);
	});
});

describe('0074_backfill_review_queue_counts', () => {
	it('counts both statuses over several pages, then marks the run complete', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedThread(t);
		for (let i = 0; i < PAGE_SIZE + 3; i++) await seedMessage(t, threadId, 'draft_ready');
		for (let i = 0; i < 2; i++) await seedMessage(t, threadId, 'awaiting_clarification');
		await seedMessage(t, threadId, 'sent');

		await backfill(t);

		const thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread).toMatchObject({ reviewDraftCount: PAGE_SIZE + 3, reviewHeldCount: 2 });
		const run = await t.run((ctx) =>
			ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.unique()
		);
		expect(run?.status).toBe('completed');
	});

	it('fails the run on a thread too large to recount, so the badge keeps reading the queue', async () => {
		const t = convexTest(schema, modules);
		const small = await seedThread(t);
		await seedMessage(t, small, 'draft_ready');
		const large = await seedThread(t);
		const bodyBytes = 256 * 1024;
		for (let i = 0; i <= RECOUNT_BYTES / bodyBytes; i++) {
			await seedMessage(t, large, 'draft_ready', bodyBytes);
		}

		await backfill(t);

		const run = await t.run((ctx) =>
			ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.unique()
		);
		expect(run?.status).toBe('running');
		expect(run?.failure?.error).toContain(large);
		expect((await t.run((ctx) => ctx.db.get(large)))?.reviewDraftCount).toBeUndefined();
		expect((await badge(t)).count).toBe(RECOUNT_BYTES / bodyBytes + 2);
	});
});
