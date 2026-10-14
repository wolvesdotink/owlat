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

/** Real transaction limits, and shared-inbox readers who all have a device. */
async function harness(): Promise<Harness> {
	_resetSingletonOrgCacheForTests();
	const t = convexTest({ schema, modules, transactionLimits: true });
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	const org = (await t.mutation(components.betterAuth.adapter.create, {
		input: { model: 'organization', data: { name: 'Acme', slug: 'acme', createdAt: Date.now() } },
	} as never)) as { _id: string };
	for (let i = 0; i < READERS; i++) {
		const userId = `reader-${i}`;
		await t.mutation(components.betterAuth.adapter.create, {
			input: {
				model: 'member',
				data: { organizationId: org._id, userId, role: 'admin', createdAt: Date.now() },
			},
		} as never);
		await seedDevice(t, userId);
	}
	return t;
}

/** `count` held messages on one new thread with this status, asked `askedAt`. */
async function seedHeld(t: Harness, count: number, status: string, askedAt: number) {
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
