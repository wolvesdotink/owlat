/**
 * Follow-up nudges in the Answer queue (SPEC §7, mail/nudges.ts): a "Waiting
 * on others" item past its due date, or 3 business days old with no reply
 * since, is a follow-up card offering "Draft a nudge", derived when the queue
 * is read. A reply from them cancels it; a fenced, muted or team thread
 * offers none; a "Remind me" reminder card offers one itself (personal
 * mailboxes only), and its thread gets no second card. The always-mounted
 * badge never counts nudge cards, one read inspects a bounded number of
 * threads, and a reply the bounded read cannot rule out means no nudge.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';
import { listBucketOf } from '../interpret/counters';
import type { T } from '../senders/__tests__/senders.testlib';
import { NUDGE_THREAD_BUDGET, THREAD_MESSAGE_SCAN } from '../nudges';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

const OWNER = 'me@owlat.test';
const SAM = 'sam@acme.test';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Thursday 2026-10-15, 10:00 UTC: when we asked. */
const ASKED = Date.UTC(2026, 9, 15, 10);
/** Three business days later (the weekend does not count). */
const TUESDAY = ASKED + 5 * DAY;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(TUESDAY + HOUR);
});
afterEach(() => {
	vi.useRealTimers();
});

interface Waiting {
	mailboxId: Id<'mailboxes'>;
	threadId: Id<'mailThreads'>;
	askId: Id<'mailMessages'>;
	itemId: Id<'threadItems'>;
}

/** Our sent question to Sam and the brief item that Sam owes us an answer. */
async function seedWaiting(
	t: T,
	opts: { scope?: 'shared'; dueAt?: number; thread?: Partial<Doc<'mailThreads'>> } = {}
): Promise<Waiting> {
	const mailboxId = await seedMailbox(t, {
		userId: 'user-A',
		address: OWNER,
		...(opts.scope ? { scope: opts.scope } : {}),
	});
	await seedFolder(t, mailboxId, 'inbox');
	await seedFolder(t, mailboxId, 'sent');
	const askId = await seedMessage(t, mailboxId, {
		subject: 'The signed contract?',
		fromAddress: OWNER,
		receivedAt: ASKED,
		role: 'sent',
	});
	return await t.run(async (ctx) => {
		const ask = (await ctx.db.get(askId))!;
		await ctx.db.patch(askId, { toAddresses: [SAM] });
		await ctx.db.patch(ask.threadId, { latestMessageId: askId, ...opts.thread });
		const fields = {
			threadKind: 'mail' as const,
			mailThreadId: ask.threadId,
			mailboxId,
			revision: 1,
			intent: 'request' as const,
			facets: [],
			assertion: 'Sam sends the signed contract',
			display: { en: 'Sam sends the signed contract', de: 'Sam schickt den Vertrag' },
			requester: { isUs: true },
			responsible: { isUs: false, email: SAM, name: 'Sam Lee' },
			responsibility: 'them' as const,
			status: 'open' as const,
			disposition: 'unanswered' as const,
			...(opts.dueAt !== undefined
				? { due: { phrase: 'by Friday', at: opts.dueAt, isAmbiguous: false } }
				: {}),
			evidence: [],
			verify: 'passed' as const,
			askedAt: ASKED,
			createdAt: ASKED,
			updatedAt: ASKED,
		};
		const itemId = await ctx.db.insert('threadItems', {
			...fields,
			listBucket: listBucketOf(fields),
		});
		return { mailboxId, threadId: ask.threadId, askId, itemId };
	});
}

async function queue(t: T, mailboxId: Id<'mailboxes'>) {
	const { items } = await t.query(api.mail.needsReply.listQueue, { mailboxId });
	// The badge counts the reply and reminder rows, never a nudge card (F5).
	const count = await t.query(api.mail.needsReply.countQueue, { mailboxId });
	expect(count).toBe(
		items.filter((item) => !item.nudge || item.nudge.reason === 'reminder').length
	);
	return items;
}

/** Another waiting item on the same thread, asked at `askedAt`. */
async function addItem(t: T, w: Waiting, askedAt: number): Promise<Id<'threadItems'>> {
	return await t.run(async (ctx) => {
		const { _id, _creationTime, ...fields } = (await ctx.db.get(w.itemId))!;
		return await ctx.db.insert('threadItems', { ...fields, askedAt, createdAt: askedAt });
	});
}

/** One more message of ours in the thread, at `at`. */
async function ownMessage(t: T, w: Waiting, at: number): Promise<void> {
	await t.run(async (ctx) => {
		const { _id, _creationTime, ...base } = (await ctx.db.get(w.askId))!;
		await ctx.db.insert('mailMessages', {
			...base,
			rfc822MessageId: `<own-${at}@owlat.test>`,
			receivedAt: at,
			internalDate: at,
		});
		await ctx.db.patch(w.threadId, { lastMessageAt: at, latestFromAddress: OWNER });
	});
}

async function replyFromSam(t: T, w: Waiting, at: number): Promise<void> {
	await t.run(async (ctx) => {
		const ask = (await ctx.db.get(w.askId))!;
		const inbox = (await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', w.mailboxId).eq('role', 'inbox'))
			.first())!;
		const { _id, _creationTime, ...base } = ask;
		await ctx.db.insert('mailMessages', {
			...base,
			folderId: inbox._id,
			fromAddress: SAM,
			toAddresses: [OWNER],
			rfc822MessageId: `<reply-${at}@acme.test>`,
			receivedAt: at,
			internalDate: at,
		});
		const thread = (await ctx.db.get(w.threadId))!;
		if (at > thread.lastMessageAt) {
			await ctx.db.patch(w.threadId, { lastMessageAt: at, latestFromAddress: SAM });
		}
	});
}

describe('nudge cards', () => {
	it('shows a dateless item 3 business days after the ask, a weekend in between', async () => {
		const t = convexTest(schema, modules);
		const w = await seedWaiting(t);

		const items = await queue(t, w.mailboxId);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			kind: 'followup',
			threadId: w.threadId,
			messageId: w.askId,
			waitingOn: SAM,
			fromName: 'Sam Lee',
			nudge: { reason: 'stale', itemId: w.itemId },
		});

		// On Monday (four calendar days, two business days) it is not stale yet.
		vi.setSystemTime(ASKED + 4 * DAY + HOUR);
		expect(await queue(t, w.mailboxId)).toEqual([]);
	});

	it('shows a dated item once its due date passed', async () => {
		const t = convexTest(schema, modules);
		vi.setSystemTime(ASKED + DAY + 2 * HOUR);
		const dueAt = ASKED + DAY;
		const w = await seedWaiting(t, { dueAt });
		expect((await queue(t, w.mailboxId))[0]?.nudge).toEqual({
			reason: 'overdue',
			itemId: w.itemId,
			dueAt,
		});
		vi.setSystemTime(dueAt - HOUR);
		expect(await queue(t, w.mailboxId)).toEqual([]);
	});

	it('is cancelled by a reply from them', async () => {
		const t = convexTest(schema, modules);
		const w = await seedWaiting(t);
		await replyFromSam(t, w, ASKED + DAY);
		expect(await queue(t, w.mailboxId)).toEqual([]);
	});

	it('offers none on a fenced, muted or team thread', async () => {
		const t = convexTest(schema, modules);
		const fenced = await seedWaiting(t, { thread: { interpretationStaleSince: ASKED } });
		expect(await queue(t, fenced.mailboxId)).toEqual([]);
		const muted = await seedWaiting(t, { thread: { mutedAt: ASKED } });
		expect(await queue(t, muted.mailboxId)).toEqual([]);
		const team = await seedWaiting(t, { scope: 'shared' });
		expect(await queue(t, team.mailboxId)).toEqual([]);
	});

	it('lets a "Remind me" reminder card offer the nudge, with no second card', async () => {
		const t = convexTest(schema, modules);
		const w = await seedWaiting(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(w.threadId, {
				followUp: { messageId: w.askId, remindAt: ASKED + DAY, armedAt: ASKED, dueAt: ASKED + DAY },
			});
		});
		const items = await queue(t, w.mailboxId);
		expect(items).toHaveLength(1);
		expect(items[0]!.nudge).toEqual({ reason: 'reminder' });

		// While the thread's reading is fenced the reminder stays, without a nudge.
		await t.run(async (ctx) => {
			await ctx.db.patch(w.threadId, { interpretationStaleSince: Date.now() });
		});
		const fenced = await queue(t, w.mailboxId);
		expect(fenced).toHaveLength(1);
		expect(fenced[0]!.nudge).toBeUndefined();
	});

	it('keeps looking at a thread whose older item was answered (F3)', async () => {
		const t = convexTest(schema, modules);
		const w = await seedWaiting(t);
		await replyFromSam(t, w, ASKED + 30 * 60_000);
		// A new ask after their reply, now stale in its own right.
		const later = await addItem(t, w, ASKED + 45 * 60_000);
		await ownMessage(t, w, ASKED + 45 * 60_000);
		const items = await queue(t, w.mailboxId);
		expect(items.map((item) => item.nudge)).toEqual([{ reason: 'stale', itemId: later }]);
	});

	it('offers no nudge when their reply may sit beyond the messages read (F4)', async () => {
		const t = convexTest(schema, modules);
		const w = await seedWaiting(t);
		await replyFromSam(t, w, ASKED + HOUR);
		for (let i = 1; i <= THREAD_MESSAGE_SCAN; i++)
			await ownMessage(t, w, ASKED + HOUR + i * 60_000);
		expect(await queue(t, w.mailboxId)).toEqual([]);
	});

	it('inspects a bounded number of threads per read (F5)', async () => {
		const t = convexTest(schema, modules);
		const first = await seedWaiting(t);
		for (let i = 0; i < NUDGE_THREAD_BUDGET; i++) {
			await t.run(async (ctx) => {
				const ask = (await ctx.db.get(first.askId))!;
				const { _id, _creationTime, ...thread } = (await ctx.db.get(ask.threadId))!;
				const threadId = await ctx.db.insert('mailThreads', thread);
				const { _id: _m, _creationTime: _mc, ...message } = ask;
				const askId = await ctx.db.insert('mailMessages', { ...message, threadId });
				const { _id: _i, _creationTime: _ic, ...item } = (await ctx.db.get(first.itemId))!;
				await ctx.db.insert('threadItems', { ...item, mailThreadId: threadId });
				await ctx.db.patch(threadId, { latestMessageId: askId });
			});
		}
		const items = await queue(t, first.mailboxId);
		expect(items).toHaveLength(NUDGE_THREAD_BUDGET);
		expect(await t.query(api.mail.needsReply.countQueue, { mailboxId: first.mailboxId })).toBe(0);
	});
});
