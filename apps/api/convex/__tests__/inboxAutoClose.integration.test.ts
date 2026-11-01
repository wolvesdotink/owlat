/**
 * Team Inbox auto-close end to end (inbox/autoClose.ts): saving the rule, the
 * sweep resolving a quiet waiting thread exactly at the deadline and nothing
 * else, the per-thread opt-out, and the provenance a later reopen clears. The
 * clock is pinned; the sweep is called directly.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { findOrCreateForEmail } from '../inbox/threads/module';

const SESSION = vi.hoisted(() => ({
	userId: 'admin-1',
	role: 'owner' as 'owner' | 'admin' | 'editor',
	activeOrganizationId: 'org-1',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const admin = async () => {
		if (SESSION.role === 'editor') throw new Error('forbidden');
		return { ...SESSION };
	};
	return {
		...actual,
		requireOrgPermission: vi.fn().mockImplementation(admin),
		requireAdminContext: vi.fn().mockImplementation(admin),
		getMutationContext: vi.fn().mockImplementation(async () => ({ ...SESSION })),
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(async () => ({ ...SESSION })),
	};
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
			!path.includes('files/processing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 5, 1, 12);

async function setup(inbox = true) {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { inbox },
			createdAt: Date.now(),
		});
	});
	return t;
}

type T = Awaited<ReturnType<typeof setup>>;

const at = (ms: number) => vi.setSystemTime(ms);

async function enable(t: T, quietDays = 3) {
	await t.mutation(api.inbox.autoClose.savePolicy, { isEnabled: true, quietDays });
}

async function insertThread(t: T, overrides: Partial<Doc<'conversationThreads'>> = {}) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('conversationThreads', {
			subject: 'Help',
			normalizedSubject: 'help',
			contactIdentifier: 'customer@example.com',
			status: 'waiting',
			messageCount: 1,
			lastMessageAt: now - DAY,
			firstMessageAt: now - DAY,
			waitingSince: now,
			createdAt: now - DAY,
			...overrides,
		});
	});
}

const getThread = (t: T, id: Id<'conversationThreads'>) => t.run((ctx) => ctx.db.get(id));
/** One cron run: the sweep's pages, then the closes it handed off. */
async function sweep(t: T) {
	const first = await t.mutation(internal.inbox.autoClose.sweep, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	return first;
}
const audits = (t: T, action: Doc<'auditLogs'>['action']) =>
	t.run((ctx) =>
		ctx.db
			.query('auditLogs')
			.withIndex('by_action', (q) => q.eq('action', action))
			.collect()
	);

beforeEach(() => {
	vi.useFakeTimers();
	at(T0);
	SESSION.role = 'owner';
});
afterEach(() => {
	vi.useRealTimers();
});

describe('auto-close policy', () => {
	it('is off until saved, then saves the days and audits', async () => {
		const t = await setup();
		expect(await t.query(api.inbox.autoClose.getPolicy, {})).toBeNull();
		await enable(t, 5);
		expect(await t.query(api.inbox.autoClose.getPolicy, {})).toMatchObject({
			isEnabled: true,
			quietDays: 5,
		});
		const saved = await audits(t, 'settings.inbox_auto_close_updated');
		expect(saved.map((row) => row.details)).toEqual([{ isEnabled: true, quietDays: 5 }]);
	});

	it('refuses days that are not a whole number from 1 to 365', async () => {
		const t = await setup();
		for (const quietDays of [0, -1, 1.5, 366, Number.NaN]) {
			await expect(
				t.mutation(api.inbox.autoClose.savePolicy, { isEnabled: true, quietDays })
			).rejects.toThrow();
		}
		expect(await t.query(api.inbox.autoClose.getPolicy, {})).toBeNull();
	});

	it('is owner/admin only, and only while the Team Inbox is on', async () => {
		const t = await setup();
		SESSION.role = 'editor';
		await expect(
			t.mutation(api.inbox.autoClose.savePolicy, { isEnabled: true, quietDays: 3 })
		).rejects.toThrow();
		await expect(t.query(api.inbox.autoClose.getPolicy, {})).rejects.toThrow();

		SESSION.role = 'owner';
		const off = await setup(false);
		await expect(
			off.mutation(api.inbox.autoClose.savePolicy, { isEnabled: true, quietDays: 3 })
		).rejects.toThrow();
	});
});

describe('the sweep', () => {
	it('resolves a quiet waiting thread exactly at N days, once', async () => {
		const t = await setup();
		await enable(t, 3);
		const id = await insertThread(t);

		at(T0 + 3 * DAY - 1);
		expect(await sweep(t)).toEqual({ due: 0, isDone: true });
		expect((await getThread(t, id))!.status).toBe('waiting');

		at(T0 + 3 * DAY);
		expect(await sweep(t)).toEqual({ due: 1, isDone: true });
		const closed = (await getThread(t, id))!;
		expect(closed.status).toBe('resolved');
		expect(closed.autoClosedAt).toBe(T0 + 3 * DAY);
		expect(closed.autoClosedQuietDays).toBe(3);
		expect(closed.resolvedAt).toBe(T0 + 3 * DAY);
		expect(closed.waitingSince).toBeUndefined();

		at(T0 + 4 * DAY);
		expect(await sweep(t)).toEqual({ due: 0, isDone: true });
		const rows = await audits(t, 'thread.auto_closed');
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			userId: 'system',
			resourceId: id,
			details: { quietDays: 3, quietSince: T0 },
		});
		expect(await audits(t, 'thread.status_changed')).toHaveLength(0);
	});

	it('gives threads that were already quiet the full period from when it was switched on', async () => {
		const t = await setup();
		const old = await insertThread(t, {
			lastMessageAt: T0 - 40 * DAY,
			waitingSince: T0 - 30 * DAY,
		});
		at(T0 + HOUR);
		await enable(t, 3);

		at(T0 + 2 * HOUR);
		await sweep(t);
		expect((await getThread(t, old))!.status).toBe('waiting');

		at(T0 + HOUR + 3 * DAY);
		await sweep(t);
		expect((await getThread(t, old))!.status).toBe('resolved');
	});

	it('leaves alone: rule off, other statuses, opted out, snoozed, a later reply', async () => {
		const t = await setup();
		const old = { lastMessageAt: T0 - 20 * DAY, waitingSince: T0 - 20 * DAY };
		const plain = await insertThread(t, old);
		await t.mutation(api.inbox.autoClose.savePolicy, { isEnabled: false, quietDays: 3 });
		at(T0 + 10 * DAY);
		await sweep(t);
		expect((await getThread(t, plain))!.status).toBe('waiting');

		at(T0);
		await enable(t, 3);
		const open = await insertThread(t, { ...old, status: 'open', waitingSince: undefined });
		const optedOut = await insertThread(t, { ...old, isAutoCloseDisabled: true });
		const snoozed = await insertThread(t, { ...old, snoozedUntil: T0 + 30 * DAY });
		const replied = await insertThread(t, { ...old, lastReplySentAt: T0 + 2 * DAY });

		at(T0 + 4 * DAY);
		await sweep(t);
		expect((await getThread(t, plain))!.status).toBe('resolved');
		expect((await getThread(t, open))!.status).toBe('open');
		expect((await getThread(t, optedOut))!.status).toBe('waiting');
		expect((await getThread(t, snoozed))!.status).toBe('waiting');
		// A reply we sent two days in restarts the quiet period.
		expect((await getThread(t, replied))!.status).toBe('waiting');
		at(T0 + 5 * DAY);
		await sweep(t);
		expect((await getThread(t, replied))!.status).toBe('resolved');
	});

	it('checks again when it closes: a reply after the sweep found it due wins', async () => {
		const t = await setup();
		await enable(t, 3);
		const id = await insertThread(t);
		at(T0 + 3 * DAY);
		expect(await t.mutation(internal.inbox.autoClose.sweep, {})).toEqual({ due: 1, isDone: true });
		await t.run((ctx) => ctx.db.patch(id, { lastReplySentAt: T0 + 3 * DAY }));
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await getThread(t, id))!.status).toBe('waiting');
		expect(await t.mutation(internal.inbox.autoClose.closeQuietThread, { threadId: id })).toEqual({
			closed: false,
		});
	});

	it('waking a snooze by hand restarts the quiet period', async () => {
		const t = await setup();
		await enable(t, 3);
		const id = await insertThread(t, { snoozedUntil: T0 + 10 * DAY });
		at(T0 + 5 * DAY);
		await t.mutation(api.inbox.snooze.unsnoozeThread, { threadId: id });
		await sweep(t);
		expect((await getThread(t, id))!.status).toBe('waiting');
		at(T0 + 8 * DAY);
		await sweep(t);
		expect((await getThread(t, id))!.status).toBe('resolved');
	});

	// The auto-close and snooze crons run on their own schedules; whichever
	// reaches a thread first at the snooze deadline, the quiet period starts there.
	it.each([
		['the auto-close sweep runs before the snooze wakes it', ['autoClose', 'snooze']],
		['the snooze wakes it before the auto-close sweep runs', ['snooze', 'autoClose']],
	] as const)('a snooze ending gives a fresh quiet period when %s', async (_, order) => {
		const t = await setup();
		await enable(t, 3);
		const id = await insertThread(t, { snoozedUntil: T0 + 10 * DAY });
		const runCrons = async () => {
			for (const cron of order) {
				if (cron === 'autoClose') await sweep(t);
				else await t.mutation(internal.inbox.snooze.internalSweep, {});
			}
		};

		at(T0 + 10 * DAY);
		await runCrons();
		const woken = (await getThread(t, id))!;
		expect(woken.status).toBe('waiting');
		expect(woken.snoozedUntil).toBeUndefined();
		expect(woken.snoozeReturnedAt).toBe(T0 + 10 * DAY);

		at(T0 + 13 * DAY - 1);
		await runCrons();
		expect((await getThread(t, id))!.status).toBe('waiting');
		at(T0 + 13 * DAY);
		await runCrons();
		expect((await getThread(t, id))!.status).toBe('resolved');
	});

	it('starts a fresh window each time the thread re-enters waiting', async () => {
		const t = await setup();
		await enable(t, 3);
		const id = await insertThread(t, { status: 'open', waitingSince: undefined });
		await t.mutation(api.inbox.mutations.updateThreadStatus, { threadId: id, status: 'waiting' });
		expect((await getThread(t, id))!.waitingSince).toBe(T0);

		at(T0 + 2 * DAY);
		await t.mutation(api.inbox.mutations.updateThreadStatus, { threadId: id, status: 'open' });
		expect((await getThread(t, id))!.waitingSince).toBeUndefined();
		await t.mutation(api.inbox.mutations.updateThreadStatus, { threadId: id, status: 'waiting' });
		expect((await getThread(t, id))!.waitingSince).toBe(T0 + 2 * DAY);

		at(T0 + 4 * DAY);
		await sweep(t);
		expect((await getThread(t, id))!.status).toBe('waiting');
		at(T0 + 5 * DAY);
		await sweep(t);
		expect((await getThread(t, id))!.status).toBe('resolved');
	});

	it('pages past threads it skips', async () => {
		const t = await setup();
		await enable(t, 1);
		// Older than the eligible one, so they fill the first page.
		for (let i = 0; i < 120; i++) {
			await insertThread(t, { lastMessageAt: T0 - 10 * DAY + i, isAutoCloseDisabled: true });
		}
		const eligible = await insertThread(t, { lastMessageAt: T0 - 5 * DAY });

		at(T0 + 2 * DAY);
		expect(await sweep(t)).toEqual({ due: 0, isDone: false });
		expect((await getThread(t, eligible))!.status).toBe('resolved');
	});
});

describe('after an automatic close', () => {
	async function autoClosed(t: T) {
		await enable(t, 3);
		const id = await insertThread(t);
		at(T0 + 3 * DAY);
		await sweep(t);
		expect((await getThread(t, id))!.autoClosedAt).toBe(T0 + 3 * DAY);
		return id;
	}

	it('a manual reopen clears the provenance', async () => {
		const t = await setup();
		const id = await autoClosed(t);
		expect(await t.query(api.inbox.autoClose.getThreadAutoClose, { threadId: id })).toMatchObject({
			isPolicyEnabled: true,
			autoClosedAt: T0 + 3 * DAY,
			autoClosedQuietDays: 3,
			dueAt: null,
		});
		await t.mutation(api.inbox.mutations.updateThreadStatus, { threadId: id, status: 'open' });
		const reopened = (await getThread(t, id))!;
		expect(reopened.status).toBe('open');
		expect(reopened.autoClosedAt).toBeUndefined();
		expect(reopened.autoClosedQuietDays).toBeUndefined();
		expect(reopened.resolvedAt).toBeUndefined();
	});

	it('keeps the days it closed after when the rule changes later', async () => {
		const t = await setup();
		const id = await autoClosed(t);
		await enable(t, 30);
		expect(await t.query(api.inbox.autoClose.getThreadAutoClose, { threadId: id })).toMatchObject({
			quietDays: 30,
			autoClosedAt: T0 + 3 * DAY,
			autoClosedQuietDays: 3,
		});
	});

	it('a customer reply reopens it and clears the provenance', async () => {
		const t = await setup();
		const id = await autoClosed(t);
		at(T0 + 4 * DAY);
		await t.run((ctx) =>
			findOrCreateForEmail(ctx, {
				contactIdentifier: 'customer@example.com',
				subject: 'Re: Help',
				normalizedSubject: 'help',
				occurredAt: Date.now(),
			})
		);
		const reopened = (await getThread(t, id))!;
		expect(reopened.status).toBe('open');
		expect(reopened.autoClosedAt).toBeUndefined();
		expect(reopened.autoClosedQuietDays).toBeUndefined();
	});
});

describe('per-thread opt-out', () => {
	it('turns off, back on with a fresh window, and audits each real change', async () => {
		const t = await setup();
		await enable(t, 3);
		const id = await insertThread(t);
		expect(await t.query(api.inbox.autoClose.getThreadAutoClose, { threadId: id })).toEqual({
			isPolicyEnabled: true,
			quietDays: 3,
			isDisabledForThread: false,
			dueAt: T0 + 3 * DAY,
			autoClosedAt: null,
			autoClosedQuietDays: null,
		});

		const off = await t.mutation(api.inbox.autoClose.setThreadAutoClose, {
			threadId: id,
			isDisabled: true,
		});
		expect(off).toEqual({ changed: true });
		expect(
			await t.mutation(api.inbox.autoClose.setThreadAutoClose, { threadId: id, isDisabled: true })
		).toEqual({ changed: false });
		expect(await t.query(api.inbox.autoClose.getThreadAutoClose, { threadId: id })).toMatchObject({
			isDisabledForThread: true,
			dueAt: null,
		});

		at(T0 + 10 * DAY);
		await sweep(t);
		expect((await getThread(t, id))!.status).toBe('waiting');

		await t.mutation(api.inbox.autoClose.setThreadAutoClose, { threadId: id, isDisabled: false });
		const resumed = (await getThread(t, id))!;
		expect(resumed.isAutoCloseDisabled).toBeUndefined();
		expect(resumed.autoCloseRestartedAt).toBe(T0 + 10 * DAY);
		await sweep(t);
		expect((await getThread(t, id))!.status).toBe('waiting');
		at(T0 + 13 * DAY);
		await sweep(t);
		expect((await getThread(t, id))!.status).toBe('resolved');

		const changes = await audits(t, 'thread.auto_close_changed');
		expect(changes.map((row) => row.details)).toEqual([
			{ isDisabled: true },
			{ isDisabled: false },
		]);
	});

	it('is owner/admin only', async () => {
		const t = await setup();
		const id = await insertThread(t);
		SESSION.role = 'editor';
		await expect(
			t.mutation(api.inbox.autoClose.setThreadAutoClose, { threadId: id, isDisabled: true })
		).rejects.toThrow();
	});
});
