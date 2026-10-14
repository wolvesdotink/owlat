/**
 * The abandoned-question reminder under production transaction limits (#1343).
 *
 * Every reminder schedules a push per person with a device, and a transaction
 * may schedule at most 1,000 functions. A page of 100 overdue questions read
 * by 11 people with push used to schedule 1,100 sends: the transaction rolled
 * back, and with it the `isThreadSettled` stamping of every legacy row on the
 * page, run after run. Here the stamping commits on the first run, the sends
 * are capped per run (`clarificationReminders.MAX_REMINDER_SENDS`), and the
 * rest go out on later runs, each person once.
 */
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import schema from '../schema';
import betterAuthSchema from '../betterAuth/schema';
import { components, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { betterAuthModules } from './testModules';
import { _resetSingletonOrgCacheForTests } from '../lib/sessionOrganization';
import { seedDevice, VAPID_ENV } from '../push/__tests__/pushFixtures';
import { createTestConversationThread, createTestInboundMessage } from './factories';
import { MAX_REMINDER_SENDS } from '../inbox/clarificationReminders';

// The push service accepts every send; no network.
vi.mock('../lib/ssrfGuard', async () => ({
	...(await vi.importActual('../lib/ssrfGuard')),
	fetchGuarded: vi.fn(async () => new Response(null, { status: 201 })),
}));

const modules = import.meta.glob('../**/*.*s');
type Harness = TestConvex<typeof schema>;

const DAY = 24 * 60 * 60 * 1000;
const READERS = 11;
const OVERDUE = 100;
const LEGACY = 205;

beforeEach(() => {
	vi.useFakeTimers();
	for (const [key, value] of Object.entries(VAPID_ENV)) vi.stubEnv(key, value);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

/** Real transaction limits, and `readers` shared-inbox readers, each with a device or none. */
async function harness(readers = READERS, hasDevices = true): Promise<Harness> {
	_resetSingletonOrgCacheForTests();
	const t = convexTest({ schema, modules, transactionLimits: true });
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	const org = (await t.mutation(components.betterAuth.adapter.create, {
		input: { model: 'organization', data: { name: 'Acme', slug: 'acme', createdAt: Date.now() } },
	} as never)) as { _id: string };
	for (let i = 0; i < readers; i++) {
		const userId = `reader-${i}`;
		await t.mutation(components.betterAuth.adapter.create, {
			input: {
				model: 'member',
				data: { organizationId: org._id, userId, role: 'admin', createdAt: Date.now() },
			},
		} as never);
		if (hasDevices) await seedDevice(t, userId);
	}
	return t;
}

/** `count` held messages on one new thread with this status, asked `askedAt`. */
async function seedHeld(
	t: Harness,
	count: number,
	status: string,
	askedAt: number,
	fields: Record<string, unknown> = {}
) {
	return t.run(async (ctx) => {
		const { updatedAt: _u, ...thread } = createTestConversationThread({
			contactId: undefined,
			status,
		});
		const threadId = await ctx.db.insert('conversationThreads', thread);
		const ids: Id<'inboundMessages'>[] = [];
		for (let i = 0; i < count; i++) {
			const { threadId: _t, ...row } = createTestInboundMessage({
				contactId: undefined,
				processingStatus: 'awaiting_clarification',
				pendingClarification: {
					questions: [{ id: 'clarify_0', slotType: 'factual_lookup', text: 'Which order?' }],
					askedAt,
				},
				...fields,
			});
			ids.push(await ctx.db.insert('inboundMessages', { ...row, threadId }));
		}
		return ids;
	});
}

it('stamps every legacy row on the first run and drains the reminders over runs, each person once', async () => {
	const t = await harness();
	await seedHeld(t, OVERDUE, 'open', Date.now() - 2 * DAY);
	// Parked before the queue's index existed, on a conversation settled since.
	const legacy = await seedHeld(t, LEGACY, 'resolved', Date.now());

	const run = async () => {
		await t.mutation(internal.inbox.processingLifecycle.reconcileAbandonedClarifications, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	};
	const reminders = () =>
		t.run(async (ctx) =>
			(await ctx.db.query('inboxAssignmentNotices').collect()).filter((n) => n.isReminder)
		);

	await run();
	const stamped = await t.run(async (ctx) => Promise.all(legacy.map((id) => ctx.db.get(id))));
	expect(stamped.filter((m) => m?.isThreadSettled === true)).toHaveLength(LEGACY);
	expect(await reminders()).toHaveLength(MAX_REMINDER_SENDS);

	const total = OVERDUE * READERS;
	for (let i = 0; i < Math.ceil(total / MAX_REMINDER_SENDS); i++) await run();
	const sent = await reminders();
	expect(sent).toHaveLength(total);
	expect(new Set(sent.map((n) => `${n.inboundMessageId}:${n.userId}`)).size).toBe(total);
}, 180_000);

// Sol's round-5 scenario: once some questions were reminded, every run used
// to re-check each (question, reader) pair with its own index read. From the
// tenth run on, 100 questions x 50 readers went over the 4,096 index ranges a
// transaction may read, the sends rolled back, and 1,400 reminders were never
// sent. Each run must send its full share until all 5,000 are out.
it('drains 100 questions x 50 readers over runs, a full share each run, nobody twice', async () => {
	const readers = 50;
	const t = await harness(readers, false);
	await seedHeld(t, OVERDUE, 'open', Date.now() - 2 * DAY);
	const total = OVERDUE * readers;
	const reminders = () =>
		t.run(async (ctx) =>
			(await ctx.db.query('inboxAssignmentNotices').collect()).filter((n) => n.isReminder)
		);

	let sent = 0;
	for (let run = 0; run < Math.ceil(total / MAX_REMINDER_SENDS); run++) {
		await t.mutation(internal.inbox.processingLifecycle.reconcileAbandonedClarifications, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const now = (await reminders()).length;
		// A run that rolled back sends nothing: the share proves it ran.
		expect(now - sent).toBe(Math.min(MAX_REMINDER_SENDS, total - sent));
		sent = now;
	}
	const all = await reminders();
	expect(all).toHaveLength(total);
	expect(new Set(all.map((n) => `${n.inboundMessageId}:${n.userId}`)).size).toBe(total);
	// Done questions are skipped from then on, and nothing more goes out.
	await t.mutation(internal.inbox.processingLifecycle.reconcileAbandonedClarifications, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	expect(await reminders()).toHaveLength(total);
}, 180_000);

// Sol's round-6 probe: held messages keep their bodies inline. When the sends
// ran inside the cron's own transaction, the cron's scan of 100 such messages
// plus the reminder's reads went over the 16 MiB a transaction may read; the
// reminders rolled back on every run and none went out. They now run in their
// own transactions, each reading a byte-bounded page.
it('reminds about 100 questions with 96 KiB bodies, with nothing rolled back', async () => {
	const t = await harness(1, false);
	await seedHeld(t, OVERDUE, 'open', Date.now() - 2 * DAY, {
		textBody: 'x'.repeat(96 * 1024),
	});
	const reminders = () =>
		t.run(async (ctx) =>
			(await ctx.db.query('inboxAssignmentNotices').collect()).filter((n) => n.isReminder)
		);

	for (let run = 0; run < 2; run++) {
		await t.mutation(internal.inbox.processingLifecycle.reconcileAbandonedClarifications, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		// Everything on the first run; nothing again on the second.
		expect(await reminders()).toHaveLength(OVERDUE);
	}
}, 180_000);

// ─── Sol's round-7 probes: bounds by shape, not by counted budgets ──────────

const KiB = 1024;

/** One run with its reminder chain, drained; the reminder notices written. */
async function runOnce(t: Harness) {
	await t.mutation(internal.inbox.processingLifecycle.reconcileAbandonedClarifications, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	return t.run(async (ctx) =>
		(await ctx.db.query('inboxAssignmentNotices').collect()).filter((n) => n.isReminder)
	);
}

/** A thread whose subject makes it about `bytes` large. */
async function bigThread(t: Harness, status: string, bytes: number) {
	return t.run(async (ctx) => {
		const { updatedAt: _u, ...thread } = createTestConversationThread({
			contactId: undefined,
			status,
			subject: 'x'.repeat(bytes),
		});
		return ctx.db.insert('conversationThreads', thread);
	});
}

/** A held, overdue message on `threadId`. */
async function heldOn(
	t: Harness,
	threadId: Id<'conversationThreads'>,
	askedAt: number,
	fields = {}
) {
	return t.run(async (ctx) => {
		const { threadId: _t, ...row } = createTestInboundMessage({
			contactId: undefined,
			processingStatus: 'awaiting_clarification',
			pendingClarification: {
				questions: [{ id: 'clarify_0', slotType: 'factual_lookup', text: 'Which order?' }],
				askedAt,
			},
			...fields,
		});
		return ctx.db.insert('inboundMessages', { ...row, threadId });
	});
}

/** Notices on one question, written a few per transaction (each one is large). */
async function seedNotices(
	t: Harness,
	messageId: Id<'inboundMessages'>,
	threadId: Id<'conversationThreads'>,
	rows: Array<Record<string, unknown>>
) {
	for (let i = 0; i < rows.length; i += 10) {
		await t.run(async (ctx) => {
			for (const row of rows.slice(i, i + 10)) {
				await ctx.db.insert('inboxAssignmentNotices', {
					kind: 'clarification',
					inboundMessageId: messageId,
					threadId,
					subject: 'Order',
					assignedByName: 'Jonas',
					createdAt: Date.now(),
					userId: 'nobody',
					...row,
				});
			}
		});
	}
}

it('reaches a live question behind settled rows on a 512 KiB thread', async () => {
	const t = await harness(1, false);
	const askedAt = Date.now() - 2 * DAY;
	const settled = await bigThread(t, 'resolved', 512 * KiB);
	for (let i = 0; i < 10; i++) await heldOn(t, settled, askedAt);
	const open = await bigThread(t, 'open', 1);
	const live = await heldOn(t, open, askedAt);

	const sent = await runOnce(t);
	expect(sent.map((n) => n.inboundMessageId)).toEqual([live]);
});

it("checks reminders without reading a question's large notices as a range", async () => {
	const readers = 50;
	const t = await harness(readers, false);
	const askedAt = Date.now() - 2 * DAY;
	const thread = await bigThread(t, 'open', 1);
	const messageId = await heldOn(t, thread, askedAt);
	const people = Array.from({ length: readers }, (_, i) => `reader-${i}`);
	const subject = 'x'.repeat(192 * KiB);
	await seedNotices(t, messageId, thread, [
		...people.map((userId) => ({ userId, subject })),
		...people.map((userId) => ({ userId, subject, isReminder: true, reminderAskedAt: askedAt })),
	]);

	await t.mutation(internal.inbox.processingLifecycle.reconcileAbandonedClarifications, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	// Everyone was reminded already: nobody twice, and the question is done.
	// (Counted per person: all of the question's notices at once are too large
	// for one test transaction too.)
	for (const userId of people) {
		const reminders = await t.run(
			async (ctx) =>
				(
					await ctx.db
						.query('inboxAssignmentNotices')
						.withIndex('by_inbound_message_user_and_reminder', (q) =>
							q
								.eq('inboundMessageId', messageId)
								.eq('userId', userId)
								.eq('reminderAskedAt', askedAt)
						)
						.collect()
				).length
		);
		expect(reminders).toBe(1);
	}
	const message = await t.run((ctx) => ctx.db.get(messageId));
	expect(message?.pendingClarification?.isRemindedForReaders).toBe(true);
});

it('finds a reminder past 500 other notices on the question', async () => {
	const t = await harness(1, false);
	const askedAt = Date.now() - 2 * DAY;
	const thread = await bigThread(t, 'open', 1);
	// Reassigned back to reader-0, who was reminded about this ask before the
	// question changed hands 500 times.
	const messageId = await heldOn(t, thread, askedAt, { assignedTo: 'reader-0' });
	await seedNotices(t, messageId, thread, [
		...Array.from({ length: 500 }, (_, i) => ({
			userId: `a-${String(i).padStart(3, '0')}`,
			isReminder: true,
			reminderAskedAt: askedAt,
		})),
		{ userId: 'reader-0', isReminder: true, reminderAskedAt: askedAt },
	]);

	const sent = await runOnce(t);
	expect(sent.filter((n) => n.userId === 'reader-0')).toHaveLength(1);
}, 60_000);

it('keeps the cron within limits over 100 questions on their own 192 KiB threads', async () => {
	const t = await harness(1, false);
	const askedAt = Date.now() - 2 * DAY;
	for (let i = 0; i < OVERDUE; i++) {
		await heldOn(t, await bigThread(t, 'open', 192 * KiB), askedAt);
	}

	const sent = await runOnce(t);
	expect(sent).toHaveLength(OVERDUE);
}, 180_000);
