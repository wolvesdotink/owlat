/**
 * Sol's round-8 probes for the held-question bookkeeping (#1343), under
 * production transaction limits: the worker's worst-case reads (patch reads
 * included), the settlement sync's bytes, the cleanup's ask generation, and
 * fair turns for every question when the run's sends are capped.
 */
import { convexTest, type TestConvex } from 'convex-test';
import { getConvexSize } from 'convex/values';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import schema from '../schema';
import betterAuthSchema from '../betterAuth/schema';
import { components, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { betterAuthModules } from './testModules';
import { _resetSingletonOrgCacheForTests } from '../lib/sessionOrganization';
import { seedDevice, VAPID_ENV } from '../push/__tests__/pushFixtures';
import { createTestConversationThread, createTestInboundMessage } from './factories';
import { remindHeldClarifications } from '../inbox/clarificationReminders';
import { transition as threadTransition } from '../inbox/threads/module';

// The push service accepts every send; no network.
vi.mock('../lib/ssrfGuard', async () => ({
	...(await vi.importActual('../lib/ssrfGuard')),
	fetchGuarded: vi.fn(async () => new Response(null, { status: 201 })),
}));

const modules = import.meta.glob('../**/*.*s');
type Harness = TestConvex<typeof schema>;

const DAY = 24 * 60 * 60 * 1000;
const KiB = 1024;

beforeEach(() => {
	vi.useFakeTimers();
	for (const [key, value] of Object.entries(VAPID_ENV)) vi.stubEnv(key, value);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

/** `readers` shared-inbox readers with a device, under real limits unless told. */
async function harness(readers = 1, hasLimits = true): Promise<Harness> {
	_resetSingletonOrgCacheForTests();
	const t = convexTest({ schema, modules, transactionLimits: hasLimits });
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

/** A thread near the 1 MiB document limit. */
async function nearLimitThread(t: Harness) {
	return t.run(async (ctx) => {
		const { updatedAt: _u, ...thread } = createTestConversationThread({
			contactId: undefined,
			status: 'open',
			subject: 'x'.repeat(1015 * KiB),
		});
		return ctx.db.insert('conversationThreads', thread);
	});
}

const askAgain = (t: Harness, id: Id<'inboundMessages'>, question: string) =>
	t.mutation(internal.inbox.processingLifecycle.transition, {
		inboundMessageId: id,
		input: {
			to: 'awaiting_clarification',
			at: Date.now(),
			pendingClarification: {
				questions: [{ id: question, slotType: 'factual_lookup', text: 'A new question' }],
				askedAt: Date.now(),
			},
		},
	});

it('keeps a new ask issued in the same millisecond as the settle', async () => {
	const t = await harness();
	vi.unstubAllEnvs();
	const [id] = await seedHeld(t, 1, 'open', Date.now() - 2 * DAY);
	await t.mutation(internal.inbox.clarificationReminders.remindHeldClarifications, {
		cursor: null,
		sendsLeft: 400,
		cutoff: Date.now(),
	});
	await t.mutation(internal.inbox.processingLifecycle.transition, {
		inboundMessageId: id!,
		input: { to: 'drafting', at: Date.now() },
	});
	await askAgain(t, id!, 'new');
	const current = await t.run((ctx) => ctx.db.query('inboxAssignmentNotices').collect());
	const newNotice = current.find((n) => !n.isReminder)!;
	expect(newNotice).toBeDefined();

	await t.finishAllScheduledFunctions(vi.runAllTimers);
	expect(await t.run((ctx) => ctx.db.get(newNotice._id))).not.toBeNull();
	// The settled ask's reminder is gone.
	const left = await t.run((ctx) => ctx.db.query('inboxAssignmentNotices').collect());
	expect(left.map((n) => n._id)).toEqual([newNotice._id]);
});

it('settles a thread with 50 held replies of 400 KiB within transaction limits', async () => {
	const t = await harness();
	vi.unstubAllEnvs();
	const held = await seedHeld(t, 50, 'open', Date.now() - 2 * DAY);
	for (const id of held) {
		await t.run((ctx) =>
			ctx.db.patch(id, { textBody: 'x'.repeat(400 * KiB), htmlBody: undefined })
		);
	}
	const threadId = (await t.run((ctx) => ctx.db.get(held[0]!)))!.threadId!;

	await expect(
		t.run((ctx) =>
			threadTransition(ctx, {
				threadId,
				input: { kind: 'status_change', to: 'resolved', source: 'user' },
			})
		)
	).resolves.toMatchObject({ ok: true });
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	const rows = await Promise.all(held.map((id) => t.run((ctx) => ctx.db.get(id))));
	expect(rows.every((m) => m?.isThreadSettled === true)).toBe(true);
});

it("pages through large old notices, is idempotent, and keeps a newer ask's", async () => {
	const t = await harness();
	vi.unstubAllEnvs();
	const settledAsk = Date.now() - 2 * DAY;
	const [id] = await seedHeld(t, 1, 'open', settledAsk);
	const threadId = (await t.run((ctx) => ctx.db.get(id!)))!.threadId!;
	for (let i = 0; i < 150; i++) {
		await t.run((ctx) =>
			ctx.db.insert('inboxAssignmentNotices', {
				kind: 'clarification',
				inboundMessageId: id!,
				threadId,
				userId: `old-${i}`,
				subject: 'x'.repeat(192 * KiB),
				assignedByName: 'Sender',
				createdAt: Date.now(),
				...(i % 2 === 0 ? { askedAt: settledAsk } : {}),
			})
		);
	}
	const fresh = await t.run((ctx) =>
		ctx.db.insert('inboxAssignmentNotices', {
			kind: 'clarification',
			inboundMessageId: id!,
			threadId,
			userId: 'new',
			subject: 'New',
			assignedByName: 'Sender',
			createdAt: Date.now(),
			askedAt: Date.now(),
		})
	);

	for (let i = 0; i < 2; i++) {
		await t.mutation(internal.inbox.clarificationHoldSync.clearClarificationNotices, {
			inboundMessageId: id!,
			askedAt: settledAsk,
			cursor: null,
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const left = await t.run((ctx) => ctx.db.query('inboxAssignmentNotices').collect());
		expect(left.map((n) => n._id)).toEqual([fresh]);
	}
});

it('fits the largest worker pages and cron with near-limit threads, bodies and push', async () => {
	const t = await harness(200);
	const held = await seedHeld(t, 8, 'open', Date.now() - 2 * DAY);
	for (const id of held) {
		const threadId = await nearLimitThread(t);
		await t.run((ctx) =>
			ctx.db.patch(id, {
				threadId,
				textBody: 'x'.repeat(250 * KiB),
				htmlBody: undefined,
				subject: '界'.repeat(200),
				from: '界'.repeat(200),
			})
		);
	}
	const run = async () => {
		await t.mutation(internal.inbox.processingLifecycle.reconcileAbandonedClarifications, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		return t.run((ctx) => ctx.db.query('inboxAssignmentNotices').collect());
	};

	const first = await run();
	expect(first).toHaveLength(400);
	expect(Math.max(...first.map((n) => getConvexSize(n)))).toBeLessThan(2 * KiB);
	for (let i = 0; i < 3; i++) await run();
	expect(await run()).toHaveLength(1600);
}, 180_000);

it('keeps a worker link under the read limit, the patch reads counted', async () => {
	const t = await harness(200, false);
	vi.unstubAllEnvs();
	const askedAt = Date.now() - 2 * DAY;
	const held = await seedHeld(t, 8, 'open', askedAt);
	for (const [j, id] of held.entries()) {
		const threadId = await nearLimitThread(t);
		await t.run((ctx) =>
			ctx.db.patch(id, {
				threadId,
				textBody: 'x'.repeat((j === 7 ? 1010 : 290) * KiB),
				htmlBody: undefined,
				subject: '界'.repeat(200),
				from: '界'.repeat(200),
			})
		);
		await t.run(async (ctx) => {
			for (let i = 0; i < 150; i++) {
				await ctx.db.insert('inboxAssignmentNotices', {
					kind: 'clarification',
					inboundMessageId: id,
					threadId,
					userId: `reader-${i}`,
					subject: '界'.repeat(200),
					assignedByName: '界'.repeat(200),
					createdAt: Date.now(),
					isReminder: true,
					reminderAskedAt: askedAt,
					askedAt,
				});
			}
		});
	}
	// A large config does not count: the link never reads it.
	await t.run((ctx) =>
		ctx.db.insert('agentConfig', {
			isAutoReplyEnabled: false,
			confidenceThreshold: 0.8,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			toneDescription: 'x'.repeat(1000 * KiB),
		})
	);

	const metrics = await t.run(async (ctx) => {
		const result = await (
			remindHeldClarifications as unknown as {
				_handler: (c: unknown, a: unknown) => Promise<{ reminded: number }>;
			}
		)._handler(ctx, { cursor: null, sendsLeft: 400, cutoff: Date.now() });
		const used = await (
			ctx as unknown as {
				meta: { getTransactionMetrics(): Promise<{ bytesRead: { used: number } }> };
			}
		).meta.getTransactionMetrics();
		return { result, bytesRead: used.bytesRead.used };
	});
	expect(metrics.result).toEqual({ reminded: 4 });
	// The documented worst case is 11.4 MiB; this valid fixture stays under it.
	expect(metrics.bytesRead).toBeLessThanOrEqual(11.4 * 1024 * KiB);
}, 120_000);

it('gives a question its turn while earlier ones ask anew every run', async () => {
	const t = await harness(200);
	vi.unstubAllEnvs();
	await t.run((ctx) =>
		ctx.db.insert('agentConfig', {
			isAutoReplyEnabled: false,
			confidenceThreshold: 0.8,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			clarificationTimeoutMs: 0,
		})
	);
	const [a, b, tail] = await seedHeld(t, 3, 'open', Date.now() - 2 * DAY);
	for (let round = 0; round < 3; round++) {
		await t.mutation(internal.inbox.processingLifecycle.reconcileAbandonedClarifications, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		if (round === 2) break;
		for (const id of [a!, b!]) {
			vi.advanceTimersByTime(1);
			await t.mutation(internal.inbox.processingLifecycle.transition, {
				inboundMessageId: id,
				input: { to: 'drafting', at: Date.now() },
			});
			vi.advanceTimersByTime(1);
			await askAgain(t, id, `new-${round}`);
		}
	}
	const tailNotices = await t.run((ctx) =>
		ctx.db
			.query('inboxAssignmentNotices')
			.withIndex('by_inbound_message_user_and_reminder', (q) => q.eq('inboundMessageId', tail!))
			.collect()
	);
	expect(tailNotices.filter((n) => n.isReminder)).toHaveLength(200);
}, 180_000);
