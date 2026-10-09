/**
 * The 30-day backfill and the first-open interpretation (ADR-0072, D5):
 * active threads only, each thread's whole history paged with a durable
 * cursor (partial until read through), sends only once they went out and
 * through the outbound run, bounded per batch and per run, paused by the
 * spend gate, one generation at a time, stopped for an inactive mailbox,
 * and nothing scheduled but interpretation (no notification, no Reply Queue
 * write). Review round 1: F1 to F5.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { seedFolder, seedMailbox, seedMessage } from '../../__tests__/helpers.testlib';
import { HISTORY_PAGE, isActiveThread, mailSourceOf } from '../backfillSources';
import { historyGapOf } from '../brief';
import { briefCompleteness } from '../purgeRepairs';
import { captureInterpretSource, captureTeamReplySnapshot } from '../sources';
import { MAX_SWEEP_TRIES, STALE_MS } from '../outstanding';
import { BACKFILL_WINDOW_MS, MAX_THREADS_PER_RUN, THREADS_PER_BATCH } from '../backfill';
import {
	addMessageToThread,
	modules,
	reduceItem,
	reduceResult,
	seedTeamThread,
	type Test,
} from './interpret.testlib';

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

describe('isActiveThread / mailSourceOf / historyGapOf', () => {
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

	it('admits our own mail as outbound, and a Postbox send only once it went out (F3)', () => {
		const id = 'm1' as Id<'mailMessages'>;
		const plain = { _id: id, outbound: undefined, sentByUserId: undefined };
		expect(mailSourceOf(plain, 'inbox')).toEqual({ kind: 'mail', id });
		expect(mailSourceOf(plain, 'sent')).toEqual({ kind: 'outboundMail', id });
		expect(mailSourceOf({ ...plain, sentByUserId: 'user-A' }, 'inbox')).toEqual({
			kind: 'outboundMail',
			id,
		});
		const sent = (state: 'queued' | 'sent' | 'bounced' | 'failed' | 'partial') =>
			mailSourceOf({ ...plain, outbound: { state, recipients: [] } }, 'sent');
		expect(sent('queued')).toBeNull();
		expect(sent('failed')).toBeNull();
		expect(sent('bounced')).toBeNull();
		expect(sent('sent')).toEqual({ kind: 'outboundMail', id });
		expect(sent('partial')).toEqual({ kind: 'outboundMail', id });
	});

	it('keeps a brief partial while history is unread or unreadable (F1, F2)', () => {
		expect(historyGapOf(null)).toBeNull();
		expect(historyGapOf({ historyState: 'done', isHistoryIncomplete: undefined })).toBeNull();
		expect(historyGapOf({ historyState: 'pending', isHistoryIncomplete: undefined })).toBe(
			'pending'
		);
		expect(historyGapOf({ historyState: 'done', isHistoryIncomplete: true })).toBe('history');
	});
});

/** The pending scheduled jobs. */
async function jobs(t: Test) {
	return t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.state.kind === 'pending')
			.map((job) => ({ name: job.name, args: job.args[0] as Record<string, unknown> }))
	);
}

const runsOf = (scheduled: Awaited<ReturnType<typeof jobs>>) =>
	scheduled.filter((job) => /interpretMessage|interpretSent/.test(job.name));
const sentRunsOf = (scheduled: Awaited<ReturnType<typeof jobs>>) =>
	scheduled.filter((job) => job.name.includes('interpretSent'));

async function job(t: Test, mailboxId: Id<'mailboxes'>) {
	return t.run((ctx) =>
		ctx.db
			.query('interpretBackfillJobs')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
			.first()
	);
}

/** Run the job's next batch under its current generation. */
async function batch(t: Test, mailboxId: Id<'mailboxes'>) {
	const current = (await job(t, mailboxId))!;
	await t.mutation(internal.mail.interpret.backfill.runBatch, {
		mailboxId,
		generation: current.generation,
	});
}

async function briefOf(t: Test, threadId: Id<'mailThreads'>) {
	return t.run((ctx) =>
		ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
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

async function threadOf(t: Test, messageId: Id<'mailMessages'>) {
	return t.run(async (ctx) => (await ctx.db.get(messageId))!.threadId);
}

describe('backfill', () => {
	it('reads every active thread’s whole history, page by page, and nothing else (F1)', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox30Days(t);
		const now = Date.now();
		const first = await seedMessage(t, mailboxId, { subject: 'active', receivedAt: now - DAY });
		const activeThread = await threadOf(t, first);
		const total = HISTORY_PAGE + 3;
		for (let i = 1; i < total; i++) {
			await addMessageToThread(
				t,
				{ mailboxId, threadId: activeThread },
				{ text: `More ${i}`, receivedAt: now - DAY + i * 1000 }
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

		expect(await t.mutation(api.mail.interpret.backfill.start, { mailboxId })).toEqual({
			started: true,
		});
		await batch(t, mailboxId);
		expect(runsOf(await jobs(t))).toHaveLength(HISTORY_PAGE);
		const pending = (await briefOf(t, activeThread))!;
		expect(pending).toMatchObject({ historyState: 'pending', completeness: 'pending' });
		expect(historyGapOf(pending)).toBe('pending');

		// The thread's own chain reads the next page from the stored cursor; a
		// stale chain (another cursor) does nothing.
		await t.mutation(internal.mail.interpret.backfill.continueHistory, {
			threadRef: { kind: 'mail', id: activeThread },
			cursor: 'not-the-cursor',
		});
		expect(runsOf(await jobs(t))).toHaveLength(HISTORY_PAGE);
		await t.mutation(internal.mail.interpret.backfill.continueHistory, {
			threadRef: { kind: 'mail', id: activeThread },
			cursor: pending.historyCursor!,
		});
		expect(runsOf(await jobs(t))).toHaveLength(total);
		expect(await briefOf(t, activeThread)).toMatchObject({ historyState: 'done' });

		// Only interpretation runs, the walk and the history chain: no notification, no classify.
		for (const scheduled of await jobs(t)) {
			expect(scheduled.name).toMatch(/interpret\/(run|outboundRun|backfill)/);
		}
		await t.run(async (ctx) => {
			expect((await ctx.db.get(activeThread))!.needsReply).toBeUndefined();
			const sources = await ctx.db
				.query('interpretSources')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', activeThread))
				.collect();
			expect(sources).toHaveLength(total);
			expect(sources.every((s) => s.eligibility.isLive)).toBe(true);
		});
		expect(await job(t, mailboxId)).toMatchObject({ status: 'completed', threadCount: 1 });

		// A second walk finds the history read through and schedules nothing.
		await t.mutation(api.mail.interpret.backfill.start, { mailboxId, restart: true });
		await batch(t, mailboxId);
		expect(runsOf(await jobs(t))).toHaveLength(total);
		expect(await job(t, mailboxId)).toMatchObject({ status: 'completed', threadCount: 0 });
	});

	it('admits sent mail only once it went out, through the outbound run (F3)', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox30Days(t);
		const now = Date.now();
		const inbound = await seedMessage(t, mailboxId, { subject: 'q', receivedAt: now - DAY });
		const threadId = await threadOf(t, inbound);
		const [queued, sent] = await t.run(async (ctx) => {
			const base = (await ctx.db.get(inbound))!;
			const { _id: _a, _creationTime: _b, ...fields } = base;
			const outbound = (state: 'queued' | 'sent', at: number) =>
				ctx.db.insert('mailMessages', {
					...fields,
					receivedAt: at,
					fromAddress: 'me@owlat.test',
					sentByUserId: 'user-A',
					outbound: { state, recipients: [] },
				});
			return [await outbound('queued', now - DAY + 2000), await outbound('sent', now - DAY + 1000)];
		});
		await t.mutation(api.mail.interpret.backfill.start, { mailboxId });
		await batch(t, mailboxId);
		const scheduled = await jobs(t);
		const ids = runsOf(scheduled).map((r) => (r.args['source'] as { id: string }).id);
		expect(ids).toContain(inbound);
		expect(ids).toContain(sent);
		expect(ids).not.toContain(queued);
		expect(sentRunsOf(scheduled).map((r) => r.args['source'])).toEqual([
			{ kind: 'outboundMail', id: sent },
		]);
		expect(await briefOf(t, threadId)).toMatchObject({ historyState: 'done' });
	});

	it('is bounded per batch and per run, and resumes from its cursor', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox30Days(t);
		const now = Date.now();
		for (let i = 0; i < THREADS_PER_BATCH + 2; i++) {
			await seedMessage(t, mailboxId, { subject: `t${i}`, receivedAt: now - DAY - i * 1000 });
		}
		await t.mutation(api.mail.interpret.backfill.start, { mailboxId });
		await batch(t, mailboxId);
		const first = (await job(t, mailboxId))!;
		expect(first).toMatchObject({ status: 'running', threadCount: THREADS_PER_BATCH });
		expect(first.cursor).toBeDefined();
		expect(runsOf(await jobs(t))).toHaveLength(THREADS_PER_BATCH);

		await t.run((ctx) => ctx.db.patch(first._id, { runThreadCount: MAX_THREADS_PER_RUN }));
		await batch(t, mailboxId);
		expect(await job(t, mailboxId)).toMatchObject({
			status: 'paused',
			pausedReason: 'run_cap',
			cursor: first.cursor,
		});

		await t.mutation(api.mail.interpret.backfill.start, { mailboxId });
		await batch(t, mailboxId);
		expect(await job(t, mailboxId)).toMatchObject({
			status: 'completed',
			cutoffAt: first.cutoffAt,
			threadCount: THREADS_PER_BATCH + 2,
		});
		expect(runsOf(await jobs(t))).toHaveLength(THREADS_PER_BATCH + 2);
	});

	it('drops a batch of an earlier run after cancel and start (F4)', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox30Days(t);
		await seedMessage(t, mailboxId, { subject: 'a', receivedAt: Date.now() - DAY });
		await t.mutation(api.mail.interpret.backfill.start, { mailboxId });
		const old = (await job(t, mailboxId))!.generation;
		await t.mutation(api.mail.interpret.backfill.cancel, { mailboxId });
		await t.mutation(api.mail.interpret.backfill.start, { mailboxId });
		await t.mutation(internal.mail.interpret.backfill.runBatch, { mailboxId, generation: old });
		expect(runsOf(await jobs(t))).toHaveLength(0);
		expect(await job(t, mailboxId)).toMatchObject({ status: 'running', scannedCount: 0 });
	});

	it('ends the job of a mailbox that is no longer active, spending nothing (F5)', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox30Days(t);
		await seedMessage(t, mailboxId, { subject: 'a', receivedAt: Date.now() - DAY });
		await t.mutation(api.mail.interpret.backfill.start, { mailboxId });
		await t.run((ctx) => ctx.db.patch(mailboxId, { status: 'deleted' }));
		await batch(t, mailboxId);
		expect(await job(t, mailboxId)).toBeNull();
		expect(runsOf(await jobs(t))).toHaveLength(0);
	});

	it('pauses on the spend gate without scheduling anything', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox30Days(t, { isAiOn: false });
		await seedMessage(t, mailboxId, { subject: 'active', receivedAt: Date.now() - DAY });
		await t.mutation(api.mail.interpret.backfill.start, { mailboxId });
		await batch(t, mailboxId);
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
	it('starts an older thread’s history on first open, once', async () => {
		const t = lazyTest();
		const mailboxId = await seedMailbox30Days(t);
		const old = await seedMessage(t, mailboxId, {
			subject: 'old',
			receivedAt: Date.now() - 90 * DAY,
		});
		const threadRef = { kind: 'mail' as const, id: await threadOf(t, old) };
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
		const threadId = await threadOf(t, message);
		session.current = { userId: 'user-B', role: 'member', activeOrganizationId: 'org-1' };
		await expect(
			t.mutation(api.mail.interpret.lazy.ensure, { threadRef: { kind: 'mail', id: threadId } })
		).rejects.toThrow();
		expect(runsOf(await jobs(t))).toHaveLength(0);
	});

	it('reads a Team Inbox thread’s replies from their snapshots, and says when one is unreadable (F2, F3)', async () => {
		const t = lazyTest();
		await enableFeatures(t, ['ai']);
		const { threadId, inboundId } = await seedTeamThread(t);
		const { snapshotted, queued } = await t.run(async (ctx) => {
			const send = (status: 'sent' | 'queued' | 'delivered') =>
				ctx.db.insert('transactionalSends', {
					kind: 'agent_reply',
					email: 'customer@example.com',
					status,
					inboundMessageId: inboundId,
				});
			const snapshotted = await send('delivered');
			await captureTeamReplySnapshot(ctx, {
				sendId: snapshotted,
				subject: 'Re: Order 42',
				text: 'Refunded today.',
			});
			const queued = await send('queued');
			// A reply sent before snapshots existed.
			await send('sent');
			return { snapshotted, queued };
		});
		session.current = { userId: 'user-A', role: 'admin', activeOrganizationId: 'org-1' };
		const threadRef = { kind: 'team' as const, id: threadId };
		expect(await t.mutation(api.mail.interpret.lazy.ensure, { threadRef })).toEqual({
			isEnqueued: true,
			runs: 2,
		});
		const scheduled = await jobs(t);
		expect(runsOf(scheduled).map((r) => r.args['source'])).toEqual([
			{ kind: 'inbound', id: inboundId },
			{ kind: 'teamReply', id: snapshotted },
		]);
		expect(sentRunsOf(scheduled).map((r) => r.args['source'])).toEqual([
			{ kind: 'teamReply', id: snapshotted },
		]);
		expect(JSON.stringify(scheduled)).not.toContain(queued);
		const brief = await t.run((ctx) =>
			ctx.db
				.query('threadBriefs')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', threadId))
				.first()
		);
		expect(brief).toMatchObject({ historyState: 'done', isHistoryIncomplete: true });
		expect(historyGapOf(brief)).toBe('history');
	});
});

describe('history and the auto-send hold (round 2 F1)', () => {
	const counts = { complete: 2, partial: 0, failed: 0, skipped: 0, unreadable: 0 };

	it('keeps the stored completeness partial while history is unread or unreadable', () => {
		expect(briefCompleteness({ sourceCounts: counts })).toBe('complete');
		expect(briefCompleteness({ sourceCounts: counts, historyState: 'pending' })).toBe('partial');
		expect(briefCompleteness({ sourceCounts: counts, historyState: 'done' })).toBe('complete');
		expect(
			briefCompleteness({ sourceCounts: counts, historyState: 'done', isHistoryIncomplete: true })
		).toBe('partial');
	});

	it('holds team auto-send when a sent reply has no snapshot to read back', async () => {
		const t = lazyTest();
		await enableFeatures(t, ['ai']);
		const { threadId, inboundId } = await seedTeamThread(t);
		await t.run((ctx) =>
			ctx.db.insert('transactionalSends', {
				kind: 'agent_reply',
				email: 'customer@example.com',
				status: 'sent',
				inboundMessageId: inboundId,
			})
		);
		session.current = { userId: 'user-A', role: 'admin', activeOrganizationId: 'org-1' };
		await t.mutation(api.mail.interpret.lazy.ensure, {
			threadRef: { kind: 'team', id: threadId },
		});
		// The customer's email is read completely.
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			source: { kind: 'inbound', id: inboundId },
			threadRef: { kind: 'team', id: threadId },
			mode: 'actions',
			contentRevision: 'rev-1',
			extractorVersion: 1,
			expectedRevision: 0,
			deletionEpoch: 0,
			sourceAt: Date.UTC(2026, 9, 7, 9, 0),
			direction: 'inbound',
			status: 'complete',
			result: reduceResult({ items: [reduceItem()], latest: undefined, facts: [] }),
		});
		const brief = await t.run((ctx) =>
			ctx.db
				.query('threadBriefs')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', threadId))
				.first()
		);
		expect(brief).toMatchObject({ isHistoryIncomplete: true, completeness: 'partial' });
		const hold = await t.query(internal.mail.interpret.teamActions.interpretationHold, {
			inboundMessageId: inboundId,
		});
		expect(hold.reason).toMatch(/incomplete/);
	});

	it('shows a history stopped by the spend gate as stalled', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox30Days(t);
		const first = await seedMessage(t, mailboxId, { subject: 'a', receivedAt: Date.now() - DAY });
		const threadId = await threadOf(t, first);
		for (let i = 1; i <= HISTORY_PAGE; i++) {
			await addMessageToThread(
				t,
				{ mailboxId, threadId },
				{ text: `More ${i}`, receivedAt: Date.now() - DAY + i * 1000 }
			);
		}
		await t.mutation(api.mail.interpret.backfill.start, { mailboxId });
		await batch(t, mailboxId);
		const pending = (await briefOf(t, threadId))!;
		expect(pending.historyState).toBe('pending');
		await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(settings!._id, {
				featureFlags: { ...settings!.featureFlags, ai: false },
			});
		});
		await t.mutation(internal.mail.interpret.backfill.continueHistory, {
			threadRef: { kind: 'mail', id: threadId },
			cursor: pending.historyCursor!,
		});
		const view = await t.query(api.mail.interpret.brief.get, {
			threadRef: { kind: 'mail', id: threadId },
			locale: 'en',
		});
		expect(view?.history).toBe('stalled');
	});
});

describe('admitted history sources until each records an outcome (round 3 F1)', () => {
	it('stays partial while one of two scheduled sources is unread', async () => {
		const t = lazyTest();
		const mailboxId = await seedMailbox30Days(t);
		const at = Date.now() - 90 * DAY;
		const first = await seedMessage(t, mailboxId, { subject: 'old', receivedAt: at });
		const threadId = await threadOf(t, first);
		const second = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'And the invoice?', receivedAt: at + 1000 }
		);
		const threadRef = { kind: 'mail' as const, id: threadId };
		expect(await t.mutation(api.mail.interpret.lazy.ensure, { threadRef })).toEqual({
			isEnqueued: true,
			runs: 2,
		});
		expect(await briefOf(t, threadId)).toMatchObject({
			historyState: 'done',
			pendingSources: 2,
		});
		const apply = (messageId: typeof first, revision: number, status: 'complete' | 'skipped') =>
			t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
				source: { kind: 'mail', id: messageId },
				threadRef,
				mode: 'brief',
				contentRevision: `rev-${revision}`,
				extractorVersion: 1,
				expectedRevision: revision,
				deletionEpoch: 0,
				sourceAt: at + revision * 1000,
				direction: 'inbound',
				status,
				...(status === 'complete'
					? { result: reduceResult({ items: [reduceItem()] }) }
					: { skipReason: 'ineligible' as const }),
			});
		await apply(first, 0, 'complete');
		expect(await briefOf(t, threadId)).toMatchObject({
			completeness: 'partial',
			pendingSources: 1,
		});
		// Any outcome settles it, a skip included.
		await apply(second, 1, 'skipped');
		const settled = (await briefOf(t, threadId))!;
		expect(settled.completeness).toBe('complete');
		expect(settled.pendingSources).toBeUndefined();
	});
});

describe('every enqueued source is outstanding until it records an outcome (final review F2)', () => {
	const applyTo = (
		t: Test,
		source:
			| { kind: 'mail'; id: Id<'mailMessages'> }
			| { kind: 'inbound'; id: Id<'inboundMessages'> },
		threadRef:
			| { kind: 'mail'; id: Id<'mailThreads'> }
			| { kind: 'team'; id: Id<'conversationThreads'> },
		revision: number
	) =>
		t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			source,
			threadRef,
			mode: threadRef.kind === 'mail' ? 'brief' : 'actions',
			contentRevision: `rev-${revision}`,
			extractorVersion: 1,
			expectedRevision: revision,
			deletionEpoch: 0,
			sourceAt: Date.UTC(2026, 9, 7, 9, revision),
			direction: 'inbound',
			status: 'complete',
			result: reduceResult({
				items: [reduceItem()],
				...(threadRef.kind === 'team' ? { latest: undefined, facts: [] } : {}),
			}),
		});

	it('mail: B completing leaves the brief incomplete while A is unread', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox30Days(t);
		const a = await seedMessage(t, mailboxId, { subject: 'A', receivedAt: Date.now() - DAY });
		const threadId = await threadOf(t, a);
		const b = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'B', receivedAt: Date.now() - DAY + 1000 }
		);
		await t.run(async (ctx) => {
			for (const id of [a, b, a]) {
				await captureInterpretSource(ctx, { source: { kind: 'mail', id }, isLive: true });
			}
		});
		expect(await briefOf(t, threadId)).toMatchObject({ pendingSources: 2 });
		const threadRef = { kind: 'mail' as const, id: threadId };
		await applyTo(t, { kind: 'mail', id: b }, threadRef, 0);
		expect(await briefOf(t, threadId)).toMatchObject({
			completeness: 'partial',
			pendingSources: 1,
		});
		// A retried outcome for B does not count twice.
		await applyTo(t, { kind: 'mail', id: b }, threadRef, 1);
		expect(await briefOf(t, threadId)).toMatchObject({ pendingSources: 1 });
		await applyTo(t, { kind: 'mail', id: a }, threadRef, 2);
		const done = (await briefOf(t, threadId))!;
		expect(done.completeness).toBe('complete');
		expect(done.pendingSources).toBeUndefined();
	});

	it('team: B completing does not clear the auto-send hold while A is unread', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId: a } = await seedTeamThread(t);
		const b = await t.run(async (ctx) => {
			const first = (await ctx.db.get(a))!;
			const { _id: _x, _creationTime: _y, ...fields } = first;
			return ctx.db.insert('inboundMessages', {
				...fields,
				messageId: '<order-42-b@example.com>',
				receivedAt: first.receivedAt + 1000,
			});
		});
		for (const id of [a, b]) {
			await t.mutation(internal.mail.interpret.teamActions.captureInbound, {
				inboundMessageId: id,
			});
		}
		const threadRef = { kind: 'team' as const, id: threadId };
		await applyTo(t, { kind: 'inbound', id: b }, threadRef, 0);
		const hold = await t.query(internal.mail.interpret.teamActions.interpretationHold, {
			inboundMessageId: b,
		});
		expect(hold.reason).toMatch(/incomplete/);
		await applyTo(t, { kind: 'inbound', id: a }, threadRef, 1);
		const after = await t.query(internal.mail.interpret.teamActions.interpretationHold, {
			inboundMessageId: b,
		});
		expect(after.reason).toBeNull();
	});
});

describe('the outstanding-source owner (round 4)', () => {
	const complete = (
		t: Test,
		source:
			| { kind: 'mail'; id: Id<'mailMessages'> }
			| { kind: 'inbound'; id: Id<'inboundMessages'> },
		threadRef:
			| { kind: 'mail'; id: Id<'mailThreads'> }
			| { kind: 'team'; id: Id<'conversationThreads'> },
		revision: number,
		contentRevision = `rev-${revision}`
	) =>
		t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			source,
			threadRef,
			mode: threadRef.kind === 'mail' ? 'brief' : 'actions',
			contentRevision,
			extractorVersion: 1,
			expectedRevision: revision,
			deletionEpoch: 0,
			sourceAt: Date.UTC(2026, 9, 7, 9, revision),
			direction: 'inbound',
			status: 'complete',
			result: reduceResult({
				items: [reduceItem()],
				...(threadRef.kind === 'team' ? { latest: undefined, facts: [] } : {}),
			}),
		});

	async function teamPair(t: Test) {
		const { threadId, inboundId: a } = await seedTeamThread(t);
		const b = await t.run(async (ctx) => {
			const first = (await ctx.db.get(a))!;
			const { _id: _x, _creationTime: _y, ...fields } = first;
			return ctx.db.insert('inboundMessages', {
				...fields,
				messageId: '<order-42-b@example.com>',
				receivedAt: first.receivedAt + 1000,
			});
		});
		return { threadId, a, b, threadRef: { kind: 'team' as const, id: threadId } };
	}

	it('F1: holds at once when another source is captured on a complete thread', async () => {
		const t = convexTest(schema, modules);
		const { a, b, threadRef } = await teamPair(t);
		await t.mutation(internal.mail.interpret.teamActions.captureInbound, { inboundMessageId: a });
		await complete(t, { kind: 'inbound', id: a }, threadRef, 0);
		expect(
			(
				await t.query(internal.mail.interpret.teamActions.interpretationHold, {
					inboundMessageId: a,
				})
			).reason
		).toBeNull();
		await t.mutation(internal.mail.interpret.teamActions.captureInbound, { inboundMessageId: b });
		const hold = await t.query(internal.mail.interpret.teamActions.interpretationHold, {
			inboundMessageId: a,
		});
		expect(hold.reason).toMatch(/incomplete/);
	});

	it('F2: a replayed outcome settles a re-enqueued source', async () => {
		const t = convexTest(schema, modules);
		const { a, threadId, threadRef } = await teamPair(t);
		await t.mutation(internal.mail.interpret.teamActions.captureInbound, { inboundMessageId: a });
		await complete(t, { kind: 'inbound', id: a }, threadRef, 0);
		await t.mutation(internal.mail.interpret.teamActions.captureInbound, { inboundMessageId: a });
		const briefOfTeam = () =>
			t.run((ctx) =>
				ctx.db
					.query('threadBriefs')
					.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', threadId))
					.first()
			);
		expect(await briefOfTeam()).toMatchObject({ pendingSources: 1, completeness: 'partial' });
		// The same extraction again: the reducer answers `replayed`.
		await complete(t, { kind: 'inbound', id: a }, threadRef, 1, 'rev-0');
		const settled = (await briefOfTeam())!;
		expect(settled.pendingSources).toBeUndefined();
		expect(settled.completeness).toBe('complete');
	});

	it('F3: re-runs a stale source a bounded number of times, then keeps the brief partial', async () => {
		const t = convexTest(schema, modules);
		const { a, b, threadId, threadRef } = await teamPair(t);
		for (const id of [a, b]) {
			await t.mutation(internal.mail.interpret.teamActions.captureInbound, {
				inboundMessageId: id,
			});
		}
		await complete(t, { kind: 'inbound', id: a }, threadRef, 0);
		const age = () =>
			t.run(async (ctx) => {
				const row = (await ctx.db
					.query('interpretSources')
					.withIndex('by_source_key', (q) => q.eq('sourceKey', `inbound:${b}`))
					.first())!;
				await ctx.db.patch(row._id, { outstandingSince: Date.now() - STALE_MS - 1 });
			});
		// The needs-reply reconcile cron runs the sweep inline.
		await age();
		await t.mutation(internal.mail.needsReplyPending.sweepPending, {});
		expect(runsOf(await jobs(t))).toHaveLength(1);
		for (let i = 1; i < MAX_SWEEP_TRIES; i++) {
			await age();
			expect(await t.mutation(internal.mail.interpret.outstanding.sweep, {})).toEqual({
				rerun: 1,
				unread: 0,
			});
		}
		expect(runsOf(await jobs(t))).toHaveLength(MAX_SWEEP_TRIES);
		await age();
		expect(await t.mutation(internal.mail.interpret.outstanding.sweep, {})).toEqual({
			rerun: 0,
			unread: 1,
		});
		const brief = await t.run((ctx) =>
			ctx.db
				.query('threadBriefs')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', threadId))
				.first()
		);
		expect(brief).toMatchObject({ unreadSources: 1, completeness: 'partial' });
		expect(brief?.pendingSources).toBeUndefined();
		expect(historyGapOf(brief)).toBe('failed');
		expect(
			(
				await t.query(internal.mail.interpret.teamActions.interpretationHold, {
					inboundMessageId: a,
				})
			).reason
		).toMatch(/incomplete/);
		// A late outcome for it lifts the hold.
		await complete(t, { kind: 'inbound', id: b }, threadRef, 1);
		expect(
			(
				await t.query(internal.mail.interpret.teamActions.interpretationHold, {
					inboundMessageId: a,
				})
			).reason
		).toBeNull();
	});
});
