/**
 * The 30-day backfill and the first-open interpretation (ADR-0072, D5):
 * active threads only, bounded per batch and per run, paused by the spend
 * gate and resumed from the cursor, idempotent, and nothing scheduled but
 * interpretation runs (no notification, no Reply Queue write).
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { seedFolder, seedMailbox, seedMessage } from '../../__tests__/helpers.testlib';
import { isActiveThread, mailSourceOf, MESSAGES_PER_THREAD } from '../backfillSources';
import { BACKFILL_WINDOW_MS, MAX_THREADS_PER_RUN, THREADS_PER_BATCH } from '../backfill';
import { addMessageToThread, modules, seedTeamThread, type Test } from './interpret.testlib';

const session = vi.hoisted(() => ({
	current: { userId: 'user-A', role: 'member', activeOrganizationId: 'org-1' } as {
		userId: string;
		role: string;
		activeOrganizationId: string;
	} | null,
}));

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session.current),
		isActiveOrgMember: vi.fn(async () => session.current !== null),
		getMutationContext: vi.fn(async () => session.current),
		getBetterAuthSessionWithRole: vi.fn(async () => session.current),
	};
});

beforeEach(() => {
	session.current = { userId: 'user-A', role: 'member', activeOrganizationId: 'org-1' };
});

const DAY = 24 * 60 * 60 * 1000;

describe('isActiveThread / mailSourceOf', () => {
	const thread = (folderRoles: string[], extra = {}) => ({
		folderRoles,
		mutedAt: undefined,
		isSelfDeliveredBrief: undefined,
		...extra,
	});

	it('keeps inbox, sent-only and custom-folder threads, drops archived, trashed and muted ones', () => {
		expect(isActiveThread(thread(['inbox']))).toBe(true);
		expect(isActiveThread(thread(['inbox', 'archive']))).toBe(true);
		expect(isActiveThread(thread(['sent']))).toBe(true);
		expect(isActiveThread(thread([]))).toBe(true);
		expect(isActiveThread(thread(['archive', 'sent']))).toBe(false);
		expect(isActiveThread(thread(['trash']))).toBe(false);
		expect(isActiveThread(thread(['spam']))).toBe(false);
		expect(isActiveThread(thread(['inbox'], { mutedAt: 1 }))).toBe(false);
		expect(isActiveThread(thread(['inbox'], { isSelfDeliveredBrief: true }))).toBe(false);
	});

	it('reads our own mail as outbound', () => {
		const id = 'm1' as Id<'mailMessages'>;
		expect(
			mailSourceOf({ _id: id, outbound: undefined, sentByUserId: undefined }, 'inbox')
		).toEqual({ kind: 'mail', id });
		expect(mailSourceOf({ _id: id, outbound: undefined, sentByUserId: undefined }, 'sent')).toEqual(
			{ kind: 'outboundMail', id }
		);
		expect(mailSourceOf({ _id: id, outbound: undefined, sentByUserId: 'user-A' }, 'inbox')).toEqual(
			{ kind: 'outboundMail', id }
		);
	});
});

/** The scheduled jobs by function name. */
async function jobs(t: Test) {
	return t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.state.kind === 'pending')
			.map((job) => ({ name: job.name, args: job.args[0] as Record<string, unknown> }))
	);
}

function runsOf(scheduled: Awaited<ReturnType<typeof jobs>>) {
	return scheduled.filter((job) => job.name.includes('interpretMessage'));
}

async function job(t: Test, mailboxId: Id<'mailboxes'>) {
	return t.run((ctx) =>
		ctx.db
			.query('interpretBackfillJobs')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
			.first()
	);
}

async function seedMailbox30Days(t: Test, opts: { isAiOn?: boolean } = {}) {
	const mailboxId = await seedMailbox(t, { address: 'me@owlat.test' });
	if (opts.isAiOn !== false) await enableFeatures(t, ['ai']);
	for (const role of ['inbox', 'archive', 'trash', 'sent'] as const) {
		await seedFolder(t, mailboxId, role);
	}
	return mailboxId;
}

describe('backfill', () => {
	it('interprets active threads of the last 30 days, a few messages each, and nothing else', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox30Days(t);
		const now = Date.now();
		const active = await seedMessage(t, mailboxId, { subject: 'active', receivedAt: now - DAY });
		const activeThread = await t.run(async (ctx) => (await ctx.db.get(active))!.threadId);
		for (let i = 0; i < MESSAGES_PER_THREAD + 2; i++) {
			await addMessageToThread(
				t,
				{ mailboxId, threadId: activeThread },
				{ text: `More ${i}`, receivedAt: now - DAY + (i + 1) * 1000 }
			);
		}
		await seedMessage(t, mailboxId, {
			subject: 'archived',
			role: 'archive',
			receivedAt: now - DAY,
		});
		await seedMessage(t, mailboxId, { subject: 'trashed', role: 'trash', receivedAt: now - DAY });
		await seedMessage(t, mailboxId, {
			subject: 'old',
			receivedAt: now - BACKFILL_WINDOW_MS - DAY,
		});
		const muted = await seedMessage(t, mailboxId, { subject: 'muted', receivedAt: now - DAY });
		await t.run(async (ctx) => ctx.db.patch((await ctx.db.get(muted))!.threadId, { mutedAt: now }));

		session.current = { userId: 'user-A', role: 'member', activeOrganizationId: 'org-1' };
		expect(await t.mutation(api.mail.interpret.backfill.start, { mailboxId })).toEqual({
			started: true,
		});
		await t.mutation(internal.mail.interpret.backfill.runBatch, { mailboxId });

		const runs = runsOf(await jobs(t));
		expect(runs).toHaveLength(MESSAGES_PER_THREAD);
		// Only interpretation runs and the walk itself: no notification, no classify.
		for (const scheduled of await jobs(t)) {
			expect(scheduled.name).toMatch(/interpret\/(run|backfill)/);
		}
		await t.run(async (ctx) => {
			const thread = (await ctx.db.get(activeThread))!;
			expect(thread.needsReply).toBeUndefined();
			const brief = await ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', activeThread))
				.first();
			expect(brief?.completeness).toBe('pending');
			// Each picked message has its snapshot, admitted as live.
			const sources = await ctx.db
				.query('interpretSources')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', activeThread))
				.collect();
			expect(sources).toHaveLength(MESSAGES_PER_THREAD);
			expect(sources.every((s) => s.eligibility.isLive)).toBe(true);
		});
		expect(await job(t, mailboxId)).toMatchObject({
			status: 'completed',
			threadCount: 1,
			messageCount: MESSAGES_PER_THREAD,
		});

		// A second walk finds every message taken and schedules nothing new.
		await t.mutation(api.mail.interpret.backfill.start, { mailboxId, restart: true });
		await t.mutation(internal.mail.interpret.backfill.runBatch, { mailboxId });
		expect(runsOf(await jobs(t))).toHaveLength(MESSAGES_PER_THREAD);
		expect(await job(t, mailboxId)).toMatchObject({ status: 'completed', threadCount: 0 });
	});

	it('is bounded per batch and per run, and resumes from its cursor', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox30Days(t);
		const now = Date.now();
		for (let i = 0; i < THREADS_PER_BATCH + 2; i++) {
			await seedMessage(t, mailboxId, { subject: `t${i}`, receivedAt: now - DAY - i * 1000 });
		}
		await t.mutation(api.mail.interpret.backfill.start, { mailboxId });
		await t.mutation(internal.mail.interpret.backfill.runBatch, { mailboxId });
		const first = (await job(t, mailboxId))!;
		expect(first).toMatchObject({ status: 'running', threadCount: THREADS_PER_BATCH });
		expect(first.cursor).toBeDefined();
		expect(runsOf(await jobs(t))).toHaveLength(THREADS_PER_BATCH);

		// The run cap pauses the walk, cursor kept.
		await t.run((ctx) => ctx.db.patch(first._id, { runThreadCount: MAX_THREADS_PER_RUN }));
		await t.mutation(internal.mail.interpret.backfill.runBatch, { mailboxId });
		expect(await job(t, mailboxId)).toMatchObject({
			status: 'paused',
			pausedReason: 'run_cap',
			cursor: first.cursor,
		});

		// Starting again resumes where it stopped, with the same cutoff.
		await t.mutation(api.mail.interpret.backfill.start, { mailboxId });
		await t.mutation(internal.mail.interpret.backfill.runBatch, { mailboxId });
		expect(await job(t, mailboxId)).toMatchObject({
			status: 'completed',
			cutoffAt: first.cutoffAt,
			threadCount: THREADS_PER_BATCH + 2,
		});
		expect(runsOf(await jobs(t))).toHaveLength(THREADS_PER_BATCH + 2);
	});

	it('pauses on the spend gate without scheduling anything', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox30Days(t, { isAiOn: false });
		await seedMessage(t, mailboxId, { subject: 'active', receivedAt: Date.now() - DAY });
		await t.mutation(api.mail.interpret.backfill.start, { mailboxId });
		await t.mutation(internal.mail.interpret.backfill.runBatch, { mailboxId });
		expect(await job(t, mailboxId)).toMatchObject({ status: 'paused', pausedReason: 'ai_off' });
		expect(runsOf(await jobs(t))).toHaveLength(0);
	});

	it('is the mailbox owner’s to start', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox30Days(t);
		session.current = { userId: 'user-B', role: 'member', activeOrganizationId: 'org-1' };
		await expect(t.mutation(api.mail.interpret.backfill.start, { mailboxId })).rejects.toThrow();
		expect(await t.query(api.mail.interpret.backfill.status, { mailboxId })).toBeNull();
	});
});

function lazyTest(): Test {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

describe('lazy.ensure', () => {
	it('interprets an older thread on first open, once', async () => {
		const t = lazyTest();
		const mailboxId = await seedMailbox30Days(t);
		const old = await seedMessage(t, mailboxId, {
			subject: 'old',
			receivedAt: Date.now() - 90 * DAY,
		});
		const threadId = await t.run(async (ctx) => (await ctx.db.get(old))!.threadId);
		const threadRef = { kind: 'mail' as const, id: threadId };

		expect(await t.mutation(api.mail.interpret.lazy.ensure, { threadRef })).toEqual({
			isEnqueued: true,
			runs: 1,
		});
		expect(await t.mutation(api.mail.interpret.lazy.ensure, { threadRef })).toEqual({
			isEnqueued: false,
			reason: 'has_brief',
		});
		expect(runsOf(await jobs(t))).toHaveLength(1);
	});

	it('refuses a reader who cannot open the thread', async () => {
		const t = lazyTest();
		const mailboxId = await seedMailbox30Days(t);
		const message = await seedMessage(t, mailboxId, { subject: 'x' });
		const threadId = await t.run(async (ctx) => (await ctx.db.get(message))!.threadId);
		session.current = { userId: 'user-B', role: 'member', activeOrganizationId: 'org-1' };
		await expect(
			t.mutation(api.mail.interpret.lazy.ensure, { threadRef: { kind: 'mail', id: threadId } })
		).rejects.toThrow();
		expect(runsOf(await jobs(t))).toHaveLength(0);
	});

	it('reads a Team Inbox thread’s newest inbound mail for an admin', async () => {
		const t = lazyTest();
		await enableFeatures(t, ['ai']);
		const { threadId } = await seedTeamThread(t);
		session.current = { userId: 'user-A', role: 'admin', activeOrganizationId: 'org-1' };
		expect(
			await t.mutation(api.mail.interpret.lazy.ensure, {
				threadRef: { kind: 'team', id: threadId },
			})
		).toEqual({ isEnqueued: true, runs: 1 });
	});
});
