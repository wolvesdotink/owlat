/**
 * Team Inbox response targets end to end: saving the policy, the clock riding
 * the thread module / snooze / processing lifecycle / follow-ups, the breach
 * sweep and its notices, the list slices, analytics and the history back-fill.
 */
import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { findOrCreateForEmail } from '../inbox/threads/module';

const ADMIN = vi.hoisted(() => ({
	userId: 'admin-1',
	role: 'owner' as const,
	activeOrganizationId: 'org-1',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgPermission: vi.fn().mockResolvedValue(ADMIN),
		requireAdminContext: vi.fn().mockResolvedValue(ADMIN),
		getMutationContext: vi.fn().mockResolvedValue(ADMIN),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue(ADMIN),
	};
});
vi.mock('../inbox/access', async () => {
	const actual = await vi.importActual('../inbox/access');
	return { ...actual, listSharedInboxReaderIds: vi.fn().mockResolvedValue(['admin-1', 'admin-2']) };
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const HOUR = 60 * 60 * 1000;

const calendarPolicy = {
	isEnabled: true,
	firstResponseMinutes: 60,
	nextResponseMinutes: 120,
	hoursMode: 'calendar' as const,
	timeZone: 'UTC',
	businessHours: [],
	holidays: [],
};

async function setup() {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { inbox: true },
			createdAt: Date.now(),
		});
	});
	return t;
}

type T = Awaited<ReturnType<typeof setup>>;

async function enable(t: T, policy = calendarPolicy) {
	await t.mutation(api.inbox.sla.policy.savePolicy, policy);
}

async function insertThread(t: T, overrides: Partial<Doc<'conversationThreads'>> = {}) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('conversationThreads', {
			subject: 'Help',
			normalizedSubject: 'help',
			contactIdentifier: 'customer@example.com',
			status: 'open',
			messageCount: 1,
			lastMessageAt: now,
			firstMessageAt: now,
			createdAt: now,
			...overrides,
		});
	});
}

const getThread = (t: T, id: Id<'conversationThreads'>) => t.run((ctx) => ctx.db.get(id));

describe('response-target policy', () => {
	it('starts disabled, saves, audits and starts clocks on open threads', async () => {
		const t = await setup();
		expect(await t.query(api.inbox.sla.policy.getPolicy, {})).toBeNull();
		const open = await insertThread(t, { lastMessageAt: Date.now() - 5 * HOUR });
		const waiting = await insertThread(t, { status: 'waiting' });

		await enable(t);
		const stored = await t.query(api.inbox.sla.policy.getPolicy, {});
		expect(stored).toMatchObject({ isEnabled: true, firstResponseMinutes: 60 });
		const audit = await t.run((ctx) =>
			ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'settings.inbox_sla_updated'))
				.collect()
		);
		expect(audit).toHaveLength(1);

		const before = Date.now();
		await t.mutation(internal.inbox.sla.apply.applyPage, {
			generation: stored!.updatedAt,
			cursor: null,
		});
		const started = await getThread(t, open);
		// The backlog's clock starts now, not at its last message.
		expect(started!.responseDueAt).toBeGreaterThanOrEqual(before + HOUR);
		expect(started!.responseDueKind).toBe('first');
		expect((await getThread(t, waiting))!.responseDueAt).toBeUndefined();
	});

	it('refuses an invalid policy', async () => {
		const t = await setup();
		await expect(
			t.mutation(api.inbox.sla.policy.savePolicy, { ...calendarPolicy, timeZone: 'Nowhere/Land' })
		).rejects.toThrow();
	});

	it('switching off clears running clocks', async () => {
		const t = await setup();
		await enable(t);
		const id = await insertThread(t, {
			responseDueAt: Date.now() + HOUR,
			responseDueKind: 'first',
		});
		await t.mutation(api.inbox.sla.policy.savePolicy, { ...calendarPolicy, isEnabled: false });
		const stored = await t.query(api.inbox.sla.policy.getPolicy, {});
		await t.mutation(internal.inbox.sla.apply.applyPage, {
			generation: stored!.updatedAt,
			cursor: null,
		});
		expect((await getThread(t, id))!.responseDueAt).toBeUndefined();
	});

	it('switching off clears paused clocks, so resolving later records no miss', async () => {
		const t = await setup();
		await enable(t);
		const threadId = await insertThread(t, {
			responseDueAt: Date.now() - HOUR,
			responseDueKind: 'first',
			responseClockStartedAt: Date.now() - 2 * HOUR,
		});
		await t.mutation(api.inbox.snooze.snoozeThread, { threadId, until: Date.now() + 10 * HOUR });
		expect((await getThread(t, threadId))!.responsePausedRemainingMs).toBeLessThan(0);

		await t.mutation(api.inbox.sla.policy.savePolicy, { ...calendarPolicy, isEnabled: false });
		const stored = await t.query(api.inbox.sla.policy.getPolicy, {});
		await t.mutation(internal.inbox.sla.apply.applyPage, {
			generation: stored!.updatedAt,
			cursor: null,
		});
		const cleared = await getThread(t, threadId);
		expect(cleared!.responsePausedRemainingMs).toBeUndefined();
		expect(cleared!.responseDueKind).toBeUndefined();

		await t.mutation(api.inbox.mutations.updateThreadStatus, { threadId, status: 'resolved' });
		expect((await getThread(t, threadId))!.slaMissedCount).toBeUndefined();
	});

	it('resolving with targets off records no miss, even before the sweep ran', async () => {
		const t = await setup();
		await enable(t);
		const threadId = await insertThread(t, {
			responsePausedRemainingMs: -HOUR,
			responseDueKind: 'first',
			snoozedUntil: Date.now() + 10 * HOUR,
		});
		await t.mutation(api.inbox.sla.policy.savePolicy, { ...calendarPolicy, isEnabled: false });
		await t.mutation(api.inbox.mutations.updateThreadStatus, { threadId, status: 'closed' });
		const thread = await getThread(t, threadId);
		expect(thread!.responsePausedRemainingMs).toBeUndefined();
		expect(thread!.slaMissedCount).toBeUndefined();
	});
});

describe('the clock on the thread', () => {
	it('starts on inbound, pauses while snoozed and closes on a sent reply', async () => {
		const t = await setup();
		await enable(t);
		const arrived = Date.now();
		const { threadId } = await t.run((ctx) =>
			findOrCreateForEmail(ctx, {
				contactIdentifier: 'customer@example.com',
				subject: 'Help',
				normalizedSubject: 'help',
				occurredAt: arrived,
			})
		);
		expect((await getThread(t, threadId))!).toMatchObject({
			responseDueAt: arrived + HOUR,
			responseDueKind: 'first',
		});

		await t.mutation(api.inbox.snooze.snoozeThread, { threadId, until: Date.now() + 10 * HOUR });
		const snoozed = await getThread(t, threadId);
		expect(snoozed!.responseDueAt).toBeUndefined();
		expect(snoozed!.responsePausedRemainingMs).toBeGreaterThan(0);

		await t.mutation(api.inbox.snooze.unsnoozeThread, { threadId });
		expect((await getThread(t, threadId))!.responseDueAt).toBeGreaterThan(Date.now());

		const messageId = await t.run((ctx) =>
			ctx.db.insert('inboundMessages', {
				messageId: '<m1@example.com>',
				from: 'customer@example.com',
				to: 'support@example.com',
				subject: 'Help',
				processingStatus: 'approved',
				receivedAt: arrived,
				threadId,
			})
		);
		const sentAt = Date.now();
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'sent', at: sentAt },
		});
		const replied = await getThread(t, threadId);
		expect(replied!.responseDueAt).toBeUndefined();
		expect(replied!).toMatchObject({ firstResponseAt: sentAt, slaMetCount: 1 });
	});

	it('stops when the only message turns out to need no reply', async () => {
		const t = await setup();
		await enable(t);
		const arrived = Date.now();
		const threadId = await insertThread(t, {
			responseDueAt: arrived + HOUR,
			responseClockStartedAt: arrived,
		});
		const messageId = await t.run((ctx) =>
			ctx.db.insert('inboundMessages', {
				messageId: '<m2@example.com>',
				from: 'news@example.com',
				to: 'support@example.com',
				subject: 'Newsletter',
				processingStatus: 'classifying',
				receivedAt: arrived,
				threadId,
			})
		);
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'archived', at: Date.now(), reason: 'classifier_spam' },
		});
		const thread = await getThread(t, threadId);
		expect(thread!.responseDueAt).toBeUndefined();
		expect(thread!.slaMissedCount).toBeUndefined();
	});

	it('a sent team follow-up is a reply too', async () => {
		const t = await setup();
		await enable(t);
		const threadId = await insertThread(t, {
			responseDueAt: Date.now() - 1,
			responseDueKind: 'next',
			firstResponseAt: Date.now() - 5 * HOUR,
		});
		const followUpId = await t.run(async (ctx) => {
			const inReplyToMessageId = await ctx.db.insert('inboundMessages', {
				messageId: '<m4@example.com>',
				from: 'customer@example.com',
				to: 'support@example.com',
				subject: 'Help',
				processingStatus: 'sent',
				receivedAt: Date.now() - HOUR,
				threadId,
			});
			return await ctx.db.insert('inboxFollowUps', {
				threadId,
				inReplyToMessageId,
				subject: 'Re: Help',
				body: 'Following up',
				status: 'sending',
				createdBy: 'admin-1',
				createdAt: Date.now(),
				sendAt: Date.now(),
			});
		});
		await t.mutation(internal.inbox.followUps.completeSend, {
			followUpId,
			outcome: { kind: 'sent', at: Date.now() },
		});
		const thread = await getThread(t, threadId);
		expect(thread!.responseDueAt).toBeUndefined();
		expect(thread!.slaMissedCount).toBe(1);
	});

	it('resolving ends the clock and stamps the resolve time', async () => {
		const t = await setup();
		await enable(t);
		const threadId = await insertThread(t, { responseDueAt: Date.now() + HOUR });
		await t.mutation(api.inbox.mutations.updateThreadStatus, { threadId, status: 'resolved' });
		const thread = await getThread(t, threadId);
		expect(thread!.responseDueAt).toBeUndefined();
		expect(thread!.resolvedAt).toBeDefined();
	});
});

describe('breaches, slices and notices', () => {
	it('notifies the assignee once per clock, and every reader when unassigned', async () => {
		const t = await setup();
		await enable(t);
		const assigned = await insertThread(t, {
			responseDueAt: Date.now() - 1,
			assignedTo: 'agent-7',
		});
		const unassigned = await insertThread(t, { responseDueAt: Date.now() - 1 });
		const later = await insertThread(t, { responseDueAt: Date.now() + 30 * 60 * 1000 });

		expect(await t.mutation(internal.inbox.sla.breaches.sweep, {})).toEqual({ notified: 2 });
		expect(await t.mutation(internal.inbox.sla.breaches.sweep, {})).toEqual({ notified: 0 });
		const notices = await t.run((ctx) => ctx.db.query('inboxAssignmentNotices').collect());
		expect(notices.map((n) => [n.kind, n.userId, n.threadId]).sort()).toEqual(
			[
				['sla_breach', 'agent-7', assigned],
				['sla_breach', 'admin-1', unassigned],
				['sla_breach', 'admin-2', unassigned],
			].sort()
		);

		const overdue = await t.query(api.inbox.queries.listThreads, { filter: 'sla-overdue' });
		expect(overdue.threads.map((r) => r._id).sort()).toEqual([assigned, unassigned].sort());
		const dueSoon = await t.query(api.inbox.queries.listThreads, { filter: 'sla-due-soon' });
		expect(dueSoon.threads.map((r) => r._id)).toEqual([later]);
		expect(await t.query(api.inbox.sla.queries.getListSummary, {})).toMatchObject({
			isEnabled: true,
			overdue: 2,
			dueSoon: 1,
		});

		// A client from before breach notices never sees them as assignments.
		const asAdmin = await t.query(api.inbox.queries.pendingAssignments, {});
		expect(asAdmin).toHaveLength(0);
		const optedIn = await t.query(api.inbox.queries.pendingAssignments, {
			includeSlaBreaches: true,
		});
		expect(optedIn.map((n) => n.kind)).toEqual(['sla_breach']);
	});

	it('cuts the slices at the clock the list sends', async () => {
		const t = await setup();
		await enable(t);
		const eight = Date.now();
		const threadId = await insertThread(t, { responseDueAt: eight + 2 * HOUR });
		const at = async (now: number) => ({
			summary: await t.query(api.inbox.sla.queries.getListSummary, { now }),
			dueSoon: await t.query(api.inbox.queries.listThreads, { filter: 'sla-due-soon', now }),
			overdue: await t.query(api.inbox.queries.listThreads, { filter: 'sla-overdue', now }),
		});

		const early = await at(eight);
		expect(early.summary).toMatchObject({ overdue: 0, dueSoon: 0 });
		expect(early.dueSoon.threads).toHaveLength(0);
		const soon = await at(eight + HOUR + 60_000);
		expect(soon.summary).toMatchObject({ overdue: 0, dueSoon: 1 });
		expect(soon.dueSoon.threads.map((r) => r._id)).toEqual([threadId]);
		const late = await at(eight + 2 * HOUR + 60_000);
		expect(late.summary).toMatchObject({ overdue: 1, dueSoon: 0 });
		expect(late.overdue.threads.map((r) => r._id)).toEqual([threadId]);
	});

	it('does nothing while targets are off', async () => {
		const t = await setup();
		await insertThread(t, { responseDueAt: Date.now() - 1 });
		expect(await t.mutation(internal.inbox.sla.breaches.sweep, {})).toEqual({ notified: 0 });
		expect(await t.query(api.inbox.sla.queries.getListSummary, {})).toMatchObject({
			isEnabled: false,
		});
	});
});

describe('analytics and history', () => {
	it('summarizes a range and back-fills older threads', async () => {
		const t = await setup();
		const day = new Date().toISOString().slice(0, 10);
		const start = Date.parse(`${day}T00:00:00Z`) + 60 * 1000;
		const answered = await insertThread(t, { firstMessageAt: start, assignedTo: 'admin-1' });
		const resolved = await insertThread(t, { firstMessageAt: start, status: 'resolved' });
		await t.run(async (ctx) => {
			await ctx.db.insert('inboundMessages', {
				messageId: '<m3@example.com>',
				from: 'customer@example.com',
				to: 'support@example.com',
				subject: 'Help',
				processingStatus: 'sent',
				receivedAt: start,
				processedAt: start + 2 * 60 * 1000,
				threadId: answered,
			});
			await ctx.db.insert('auditLogs', {
				userId: 'system',
				action: 'thread.status_changed',
				resource: 'conversation_thread',
				resourceId: resolved,
				details: { from: 'open', to: 'resolved' },
				createdAt: start + 3 * 60 * 1000,
			});
		});

		const empty = await t.query(api.inbox.sla.queries.getAnalytics, { fromDay: day, toDay: day });
		expect(empty.history).toBe('not_started');
		expect(empty.firstResponse).toBeNull();

		expect(await t.mutation(api.inbox.sla.queries.startHistoryBackfill, {})).toEqual({
			started: true,
		});
		expect(await t.mutation(api.inbox.sla.queries.startHistoryBackfill, {})).toEqual({
			started: false,
		});
		const run = await t.run((ctx) =>
			ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) =>
					q.eq('migration', '0065_backfill_thread_response_metrics')
				)
				.unique()
		);
		let cursor: string | null = null;
		for (let i = 0; i < 5; i++) {
			const page = await t.mutation(
				internal.migrations['0065_backfill_thread_response_metrics'].processPage,
				{ cursor, generation: run!.generation }
			);
			const ledger = await t.run((ctx) => ctx.db.get(run!._id));
			if (page.isDone) break;
			cursor = ledger!.cursor ?? null;
		}

		const filled = await t.query(api.inbox.sla.queries.getAnalytics, { fromDay: day, toDay: day });
		expect(filled.history).toBe('completed');
		expect(filled.conversations).toBe(2);
		expect(filled.firstResponse).toMatchObject({ median: 2 * 60 * 1000, count: 1 });
		expect(filled.resolution).toMatchObject({ median: 3 * 60 * 1000, count: 1 });
		expect(filled.daily).toHaveLength(1);
		expect(filled.assignees.map((r) => r.userId).sort()).toEqual(['admin-1', null].sort());
	});

	it('refuses a reversed or oversized range', async () => {
		const t = await setup();
		await expect(
			t.query(api.inbox.sla.queries.getAnalytics, { fromDay: '2026-02-01', toDay: '2026-01-01' })
		).rejects.toThrow();
		await expect(
			t.query(api.inbox.sla.queries.getAnalytics, { fromDay: '2024-01-01', toDay: '2026-01-01' })
		).rejects.toThrow();
	});
});
