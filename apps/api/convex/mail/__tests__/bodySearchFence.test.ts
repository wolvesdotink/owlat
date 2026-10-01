/**
 * Deep body search (ADR-0059): the fences around its background writes.
 *
 * Two separate promises, tested separately:
 *   - the index walk's progress is tied to the run that loaded it (#943): a
 *     batch from a cancelled, restarted, duplicated or replayed run changes
 *     nothing, an accepted commit carries its own continuation, and a walk that
 *     stops is reported and can be run again;
 *   - the opt-out holds for background work too (#958): nothing writes an
 *     excerpt while the switch is off, and the sweep that follows an opt-out
 *     is fenced, restartable, and ends with no excerpt left anywhere.
 *
 * Scheduled functions run only when the test drains them (fake timers), so
 * each test decides exactly what is in flight when.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import type * as MessageBody from '../../lib/messageBody';
import { api, internal } from '../../_generated/api';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

const bodyReadFailure = vi.hoisted(() => ({ remaining: 0 }));

vi.mock('../../lib/messageBody', async () => {
	const actual = await vi.importActual<typeof MessageBody>('../../lib/messageBody');
	return {
		...actual,
		readMailMessageText: vi.fn(async (...args: Parameters<typeof actual.readMailMessageText>) => {
			if (bodyReadFailure.remaining > 0) {
				bodyReadFailure.remaining -= 1;
				throw new Error('storage read failed');
			}
			return actual.readMailMessageText(...args);
		}),
	};
});

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
		requireOrgPermission: vi.fn(async () => session),
		getUserIdFromSession: vi.fn(async () => session.userId),
	};
});

beforeEach(() => {
	vi.useFakeTimers();
	bodyReadFailure.remaining = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

type T = TestConvex<typeof schema>;

async function drain(t: T): Promise<void> {
	await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** Run only the functions due now, not what they schedule in turn. */
async function runDueOnce(t: T): Promise<void> {
	vi.advanceTimersToNextTimer();
	await t.finishInProgressScheduledFunctions();
}

async function setIndexing(t: T, enabled: boolean): Promise<void> {
	await t.mutation(api.workspaces.settings.update, { isBodySearchIndexingEnabled: enabled });
}

async function excerptOf(t: T, messageId: Id<'mailMessages'>): Promise<string | undefined> {
	// Read through a closure: `t.run` hands its result back as a Convex value,
	// which turns `undefined` into `null`.
	let value: string | undefined;
	await t.run(async (ctx) => {
		value = (await ctx.db.get(messageId))?.searchBody;
	});
	return value;
}

async function jobOf(t: T, mailboxId: Id<'mailboxes'>) {
	return t.run((ctx) =>
		ctx.db
			.query('mailBodySearchBackfillJobs')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
			.first()
	);
}

async function purgeRow(t: T) {
	return t.run((ctx) => ctx.db.query('mailBodySearchPurges').first());
}

/** Scheduled functions of one name that have not run yet. */
async function pending(t: T, name: string) {
	const all = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
	return all.filter((fn) => fn.name === name && fn.state.kind === 'pending');
}

async function countExcerpts(t: T): Promise<number> {
	const rows = await t.run((ctx) => ctx.db.query('mailMessages').collect());
	return rows.filter((row) => row.searchBody !== undefined).length;
}

async function seedInbox(t: T): Promise<Id<'mailboxes'>> {
	const mailboxId = await seedMailbox(t);
	await seedFolder(t, mailboxId);
	return mailboxId;
}

/** `count` messages received in order, optionally already carrying an excerpt. */
async function seedMany(
	t: T,
	mailboxId: Id<'mailboxes'>,
	count: number,
	searchBody?: string
): Promise<Id<'mailMessages'>[]> {
	const ids: Id<'mailMessages'>[] = [];
	for (let i = 0; i < count; i++) {
		ids.push(
			await seedMessage(t, mailboxId, {
				subject: `message ${i}`,
				textBodyInline: `body of message ${i}`,
				receivedAt: 1_000 + i,
				...(searchBody ? { searchBody } : {}),
			})
		);
	}
	return ids;
}

const RUN_BATCH = 'mail/bodySearchBackfill:runBatch';
const PURGE_PAGE = 'mail/bodySearchBackfill:purgeSearchBodies';

describe('index walk: commits are fenced to the run that loaded them (#943)', () => {
	it('a batch loaded before cancel and restart changes nothing in the new run', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const [older] = await seedMany(t, mailboxId, 1);
		await setIndexing(t, true);
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });

		// The first run's action has read its (final) page and is still busy.
		const stale = await t.query(internal.mail.bodySearchBackfill.loadBatch, { mailboxId });
		if (!stale) throw new Error('expected a batch');
		const newer = await seedMessage(t, mailboxId, { subject: 'arrived later', receivedAt: 5_000 });
		await t.mutation(api.mail.bodySearchBackfill.cancel, { mailboxId });
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });
		const restarted = await jobOf(t, mailboxId);
		const scheduledBefore = await pending(t, RUN_BATCH);

		const outcome = await t.mutation(internal.mail.bodySearchBackfill.commitBatch, {
			mailboxId,
			generation: stale.generation,
			expectedCursor: stale.expectedCursor,
			excerpts: stale.rows.map((row) => ({ messageId: row.messageId, searchBody: 'stale' })),
			scanned: stale.rows.length,
			cursor: null,
		});

		expect(outcome).toBe('rejected');
		expect(await excerptOf(t, older!)).toBeUndefined();
		expect(await jobOf(t, mailboxId)).toEqual(restarted);
		expect(await pending(t, RUN_BATCH)).toHaveLength(scheduledBefore.length);

		// The restarted run covers everything, including the message that arrived
		// after the stale page was read.
		await drain(t);
		const job = await jobOf(t, mailboxId);
		expect(job?.status).toBe('completed');
		expect(job?.scannedCount).toBe(2);
		expect(await excerptOf(t, older!)).toBe('body of message 0');
		expect(await excerptOf(t, newer)).toBe('arrived later');
	});

	it('a duplicate or out-of-order commit neither double counts nor regresses progress', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		await seedMany(t, mailboxId, 50); // two pages of 48
		await setIndexing(t, true);
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });

		const first = await t.query(internal.mail.bodySearchBackfill.loadBatch, { mailboxId });
		if (!first) throw new Error('expected a batch');
		const commitFirst = () =>
			t.mutation(internal.mail.bodySearchBackfill.commitBatch, {
				mailboxId,
				generation: first.generation,
				expectedCursor: first.expectedCursor,
				excerpts: first.rows.map((row) => ({ messageId: row.messageId, searchBody: 'x' })),
				scanned: first.rows.length,
				cursor: first.continueCursor,
			});

		expect(await commitFirst()).toBe('committed');
		const afterFirst = await jobOf(t, mailboxId);
		expect(afterFirst?.scannedCount).toBe(48);
		expect(afterFirst?.indexedCount).toBe(48);

		// The same page again, e.g. a replayed action: refused.
		expect(await commitFirst()).toBe('rejected');
		expect(await jobOf(t, mailboxId)).toEqual(afterFirst);

		// The second page commits, then the first page arrives late: refused, and
		// the cursor does not move back.
		const second = await t.query(internal.mail.bodySearchBackfill.loadBatch, { mailboxId });
		if (!second) throw new Error('expected a batch');
		expect(second.expectedCursor).toBe(first.continueCursor);
		expect(
			await t.mutation(internal.mail.bodySearchBackfill.commitBatch, {
				mailboxId,
				generation: second.generation,
				expectedCursor: second.expectedCursor,
				excerpts: [],
				scanned: second.rows.length,
				cursor: null,
			})
		).toBe('completed');
		expect(await commitFirst()).toBe('rejected');
		const done = await jobOf(t, mailboxId);
		expect(done?.status).toBe('completed');
		expect(done?.scannedCount).toBe(50);
	});

	it('an accepted commit schedules the next page itself, so nothing after it can strand the walk', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		await seedMany(t, mailboxId, 50);
		await setIndexing(t, true);
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });
		const [kickoff] = await pending(t, RUN_BATCH);
		await t.run((ctx) => ctx.scheduler.cancel(kickoff!._id));

		// Commit directly, as if the action died the moment the commit returned.
		const batch = await t.query(internal.mail.bodySearchBackfill.loadBatch, { mailboxId });
		if (!batch) throw new Error('expected a batch');
		await t.mutation(internal.mail.bodySearchBackfill.commitBatch, {
			mailboxId,
			generation: batch.generation,
			expectedCursor: batch.expectedCursor,
			excerpts: [],
			scanned: batch.rows.length,
			cursor: batch.continueCursor,
		});

		const job = await jobOf(t, mailboxId);
		const [next] = await pending(t, RUN_BATCH);
		expect(next?._id).toBe(job?.batchFunctionId);
		expect(next?.args[0]).toEqual({ mailboxId, generation: batch.generation });

		await drain(t);
		const done = await jobOf(t, mailboxId);
		expect(done?.status).toBe('completed');
		expect(done?.scannedCount).toBe(50);
		expect(done?.batchFunctionId).toBeUndefined();
	});

	it('a body that cannot be read fails the walk visibly, and start runs it again', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const [message] = await seedMany(t, mailboxId, 1);
		await setIndexing(t, true);
		bodyReadFailure.remaining = 1;
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });
		await drain(t);

		const failed = await t.query(api.mail.bodySearchBackfill.status, { mailboxId });
		expect(failed?.status).toBe('failed');
		expect(failed?.errorMessage).toBe('A message body could not be read');
		expect(failed?.isStalled).toBe(false);
		expect(await pending(t, RUN_BATCH)).toHaveLength(0);
		expect(await excerptOf(t, message!)).toBeUndefined();

		expect(await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId })).toEqual({
			started: true,
		});
		await drain(t);
		expect((await jobOf(t, mailboxId))?.status).toBe('completed');
		expect(await excerptOf(t, message!)).toBe('body of message 0');
	});

	it('a running walk whose batch died is reported stalled and restarted by start', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const [message] = await seedMany(t, mailboxId, 1);
		await setIndexing(t, true);
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });
		expect((await t.query(api.mail.bodySearchBackfill.status, { mailboxId }))?.isStalled).toBe(
			false
		);

		// The action behind the lease will never run (Convex does not retry actions).
		const leased = await jobOf(t, mailboxId);
		await t.run((ctx) => ctx.scheduler.cancel(leased!.batchFunctionId!));
		const stalled = await t.query(api.mail.bodySearchBackfill.status, { mailboxId });
		expect(stalled?.status).toBe('running');
		expect(stalled?.isStalled).toBe(true);

		expect(await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId })).toEqual({
			started: true,
		});
		expect((await jobOf(t, mailboxId))?.generation).toBe((leased?.generation ?? 0) + 1);
		await drain(t);
		expect((await jobOf(t, mailboxId))?.status).toBe('completed');
		expect(await excerptOf(t, message!)).toBe('body of message 0');
	});

	it('a live walk is still left alone by a second start', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		await seedMany(t, mailboxId, 1);
		await setIndexing(t, true);
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });
		const before = await jobOf(t, mailboxId);
		expect(await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId })).toEqual({
			started: false,
		});
		expect(await jobOf(t, mailboxId)).toEqual(before);
	});

	it('a batch queued by the previous release runs as the current generation', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const [message] = await seedMany(t, mailboxId, 1);
		await setIndexing(t, true);
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });
		const [kickoff] = await pending(t, RUN_BATCH);
		await t.run((ctx) => ctx.scheduler.cancel(kickoff!._id));

		await t.action(internal.mail.bodySearchBackfill.runBatch, { mailboxId });
		expect((await jobOf(t, mailboxId))?.status).toBe('completed');
		expect(await excerptOf(t, message!)).toBe('body of message 0');
	});

	it('a commit without a fence, from an action of the previous release, is refused', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const [message] = await seedMany(t, mailboxId, 1);
		await setIndexing(t, true);
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });
		const before = await jobOf(t, mailboxId);
		expect(
			await t.mutation(internal.mail.bodySearchBackfill.commitBatch, {
				mailboxId,
				excerpts: [{ messageId: message!, searchBody: 'unfenced' }],
				scanned: 1,
				cursor: null,
			})
		).toBe('rejected');
		expect(await excerptOf(t, message!)).toBeUndefined();
		expect(await jobOf(t, mailboxId)).toEqual(before);
	});
});

describe('opt-out: background writes honour the switch (#958)', () => {
	it('a batch in flight when the switch goes off writes no excerpt', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const [message] = await seedMany(t, mailboxId, 1);
		await setIndexing(t, true);
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });
		const batch = await t.query(internal.mail.bodySearchBackfill.loadBatch, { mailboxId });
		if (!batch) throw new Error('expected a batch');

		await setIndexing(t, false);
		expect(
			await t.mutation(internal.mail.bodySearchBackfill.commitBatch, {
				mailboxId,
				generation: batch.generation,
				expectedCursor: batch.expectedCursor,
				excerpts: [{ messageId: message!, searchBody: 'late excerpt' }],
				scanned: 1,
				cursor: null,
			})
		).toBe('rejected');
		expect(await excerptOf(t, message!)).toBeUndefined();

		await drain(t);
		expect(await excerptOf(t, message!)).toBeUndefined();
		const job = await jobOf(t, mailboxId);
		expect(job?.mode).toBe('purge');
		expect(job?.status).toBe('completed');
	});

	it('the commit re-reads the switch even when the job row still looks like a running index walk', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const [message] = await seedMany(t, mailboxId, 1);
		await setIndexing(t, true);
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });
		const batch = await t.query(internal.mail.bodySearchBackfill.loadBatch, { mailboxId });
		if (!batch) throw new Error('expected a batch');
		// Only the setting changes; the job row is left exactly as it was.
		await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(settings!._id, { isBodySearchIndexingEnabled: false });
		});

		expect(
			await t.mutation(internal.mail.bodySearchBackfill.commitBatch, {
				mailboxId,
				generation: batch.generation,
				expectedCursor: batch.expectedCursor,
				excerpts: [{ messageId: message!, searchBody: 'late excerpt' }],
				scanned: 1,
				cursor: null,
			})
		).toBe('rejected');
		expect(await excerptOf(t, message!)).toBeUndefined();
		expect(await t.query(internal.mail.bodySearchBackfill.loadBatch, { mailboxId })).toBeNull();
	});

	it('turning the switch off retires a running index walk in the same transaction', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		await seedMany(t, mailboxId, 1);
		await setIndexing(t, true);
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });
		const running = await jobOf(t, mailboxId);

		await setIndexing(t, false);
		const retired = await jobOf(t, mailboxId);
		expect(retired?.mode).toBe('purge');
		expect(retired?.generation).toBe((running?.generation ?? 0) + 1);
		expect(
			await t.query(internal.mail.bodySearchBackfill.loadBatch, {
				mailboxId,
				generation: running?.generation,
			})
		).toBeNull();
		expect((await purgeRow(t))?.status).toBe('running');
	});

	it('a sweep over several pages clears every excerpt and records its progress', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		await seedMany(t, mailboxId, 257, 'stored excerpt'); // two pages of 256
		await setIndexing(t, true);
		await setIndexing(t, false);
		await drain(t);

		expect(await countExcerpts(t)).toBe(0);
		const purge = await purgeRow(t);
		expect(purge?.status).toBe('completed');
		expect(purge?.scannedCount).toBe(257);
		expect(purge?.clearedCount).toBe(257);
		expect(purge?.batchFunctionId).toBeUndefined();
	});

	it('on then off again mid-sweep starts over from the first row; the older sweep stops', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const ids = await seedMany(t, mailboxId, 257, 'stored excerpt');
		await setIndexing(t, true);
		await setIndexing(t, false);
		await runDueOnce(t); // first page cleared, second page queued
		expect((await purgeRow(t))?.scannedCount).toBe(256);

		await setIndexing(t, true);
		expect((await purgeRow(t))?.status).toBe('cancelled');
		expect((await jobOf(t, mailboxId))?.status).not.toBe('running');
		// While on, new mail lands with an excerpt behind the old sweep's cursor.
		await t.run((ctx) => ctx.db.patch(ids[0]!, { searchBody: 'written while on' }));

		await setIndexing(t, false);
		expect((await purgeRow(t))?.generation).toBe(2);
		await drain(t);

		expect(await countExcerpts(t)).toBe(0);
		const purge = await purgeRow(t);
		expect(purge?.status).toBe('completed');
		expect(purge?.generation).toBe(2);
		// Only the current sweep counted: the first sweep's queued page did nothing.
		expect(purge?.scannedCount).toBe(257);
	});

	it('an explicit off on an instance that is already off clears what was left behind', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const [message] = await seedMany(t, mailboxId, 1, 'left behind');

		// Saving other settings does not start a sweep.
		await t.mutation(api.workspaces.settings.update, { timezone: 'Europe/Berlin' });
		await drain(t);
		expect(await excerptOf(t, message!)).toBe('left behind');
		expect(await purgeRow(t)).toBeNull();

		await setIndexing(t, false);
		await drain(t);
		expect(await excerptOf(t, message!)).toBeUndefined();
		expect((await purgeRow(t))?.status).toBe('completed');
	});

	it('a re-stated off joins a live sweep instead of starting a second one', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		await seedMany(t, mailboxId, 1, 'stored excerpt');
		await setIndexing(t, true);
		await setIndexing(t, false);
		const first = await purgeRow(t);

		await setIndexing(t, false);
		expect(await purgeRow(t)).toEqual(first);
		expect(await pending(t, PURGE_PAGE)).toHaveLength(1);
	});

	it('a sweep whose page failed is started again by the next explicit off', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const [message] = await seedMany(t, mailboxId, 1, 'stored excerpt');
		await setIndexing(t, true);
		await setIndexing(t, false);
		const dead = await purgeRow(t);
		await t.run((ctx) => ctx.scheduler.cancel(dead!.batchFunctionId!));

		await setIndexing(t, false);
		expect((await purgeRow(t))?.generation).toBe((dead?.generation ?? 0) + 1);
		await drain(t);
		expect(await excerptOf(t, message!)).toBeUndefined();
		expect((await purgeRow(t))?.status).toBe('completed');
	});

	it('a sweep page queued by the previous release hands over to a fenced sweep', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const [message] = await seedMany(t, mailboxId, 1, 'stored excerpt');

		await t.mutation(internal.mail.bodySearchBackfill.purgeSearchBodies, { cursor: null });
		expect((await purgeRow(t))?.status).toBe('running');
		await drain(t);
		expect(await excerptOf(t, message!)).toBeUndefined();
		expect((await purgeRow(t))?.status).toBe('completed');
	});

	it('the residual-cleanup migration clears excerpts only while the switch is off', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const [message] = await seedMany(t, mailboxId, 1, 'left behind');

		await setIndexing(t, true);
		expect(
			await t.mutation(internal.migrations['0051_clear_residual_search_bodies'].run, {})
		).toMatchObject({ started: false });
		await drain(t);
		expect(await excerptOf(t, message!)).toBe('left behind');

		await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(settings!._id, { isBodySearchIndexingEnabled: false });
		});
		expect(
			await t.mutation(internal.migrations['0051_clear_residual_search_bodies'].run, {})
		).toEqual({ started: true });
		// Running it again while the sweep is live joins it.
		expect(
			await t.mutation(internal.migrations['0051_clear_residual_search_bodies'].run, {})
		).toMatchObject({ started: false });
		await drain(t);
		expect(await excerptOf(t, message!)).toBeUndefined();
	});
});
