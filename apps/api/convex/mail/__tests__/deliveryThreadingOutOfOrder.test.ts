/**
 * Threading when a conversation's messages arrive out of order.
 *
 * External IMAP backfill walks each folder newest-first, and a mailbox's
 * folders are walked one after another, so a reply routinely lands before the
 * message it answers. References / In-Reply-To lookup only finds messages the
 * mailbox already holds, so every parent that arrived after its reply opened a
 * thread of its own and one conversation showed as several.
 *
 * The conversation root recorded on each message (`threadRootId`) is what
 * pulls them back together. The second half pins IMAP APPEND: a desktop
 * client's Sent copy of a reply joins the conversation it answers.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { insertDeliveredMessage } from '../deliveryPipeline/insert';
import { modules, seedMailbox, seedFolder } from './helpers.testlib';

const ME = 'me@owlat.test';
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const DAY = 24 * 60 * 60 * 1000;

interface Delivered {
	from: string;
	to: string[];
	subject: string;
	messageId: string;
	inReplyTo?: string;
	references?: string;
	receivedAt: number;
}

async function setup(): Promise<{ t: TestConvex<typeof schema>; mailboxId: Id<'mailboxes'> }> {
	const t = convexTest(schema, modules);
	const mailboxId = await seedMailbox(t, { address: ME, domain: 'owlat.test' });
	await seedFolder(t, mailboxId, 'inbox');
	await seedFolder(t, mailboxId, 'sent');
	await seedFolder(t, mailboxId, 'drafts');
	return { t, mailboxId };
}

async function folderId(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	role: 'inbox' | 'sent' | 'drafts'
): Promise<Id<'mailFolders'>> {
	return t.run(async (ctx) => {
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', role))
			.first();
		return folder!._id;
	});
}

/** Deliver into the inbox through the real insert step; returns the thread id. */
async function deliver(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	msg: Delivered
): Promise<Id<'mailThreads'>> {
	return t.run(async (ctx) => {
		const mailbox = (await ctx.db.get(mailboxId))!;
		const folder = (await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', 'inbox'))
			.first())!;
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const id = await insertDeliveredMessage(ctx, {
			mailbox,
			folder,
			rawStorageId,
			rawSize: 3,
			from: msg.from,
			to: msg.to,
			cc: [],
			bcc: [],
			subject: msg.subject,
			textBodyInline: 'body',
			messageId: msg.messageId,
			inReplyTo: msg.inReplyTo,
			references: msg.references,
			receivedAt: msg.receivedAt,
			attachments: [],
		});
		return (await ctx.db.get(id))!.threadId;
	});
}

async function append(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	role: 'sent' | 'drafts',
	msg: { messageId: string; inReplyTo?: string; references?: string[]; internalDate: number }
): Promise<Id<'mailThreads'>> {
	const rawStorageId = await t.run(async (ctx) => ctx.storage.store(new Blob(['raw'])));
	const result = await t.mutation(internal.mail.imap.append.appendMessage, {
		folderId: await folderId(t, mailboxId, role),
		rawStorageId,
		rawSize: 3,
		rfc822MessageId: msg.messageId,
		inReplyTo: msg.inReplyTo,
		references: msg.references,
		fromAddress: ME,
		toAddresses: [ALICE],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Re: Plan',
		internalDate: msg.internalDate,
		flags: ['\\Seen'],
	});
	return t.run(async (ctx) => (await ctx.db.get(result.messageId))!.threadId);
}

describe('threading when messages arrive out of order', () => {
	it('keeps a conversation imported newest-first in one thread', async () => {
		const { t, mailboxId } = await setup();
		const t0 = Date.now() - 30 * DAY;
		// Days apart, so the 24h subject fallback cannot be what joins them.
		const third = await deliver(t, mailboxId, {
			from: ALICE,
			to: [ME],
			subject: 'Re: Plan',
			messageId: '<c@example.com>',
			inReplyTo: '<b@owlat.test>',
			references: '<a@example.com> <b@owlat.test>',
			receivedAt: t0 + 6 * DAY,
		});
		const second = await deliver(t, mailboxId, {
			from: ME,
			to: [ALICE],
			subject: 'Re: Plan',
			messageId: '<b@owlat.test>',
			inReplyTo: '<a@example.com>',
			references: '<a@example.com>',
			receivedAt: t0 + 3 * DAY,
		});
		const root = await deliver(t, mailboxId, {
			from: ALICE,
			to: [ME],
			subject: 'Plan',
			messageId: '<a@example.com>',
			receivedAt: t0,
		});

		expect(second).toBe(third);
		expect(root).toBe(third);
		const thread = await t.run(async (ctx) => ctx.db.get(third));
		expect(thread?.messageCount).toBe(3);
		// The root arrived last but is the oldest message; the newest stays latest.
		expect(thread?.firstMessageAt).toBe(t0);
		expect(thread?.lastMessageAt).toBe(t0 + 6 * DAY);
	});

	it('joins a chain whose client sends only In-Reply-To', async () => {
		const { t, mailboxId } = await setup();
		const t0 = Date.now() - 30 * DAY;
		const third = await deliver(t, mailboxId, {
			from: ALICE,
			to: [ME],
			subject: 'Re: Plan',
			messageId: '<irt-c@example.com>',
			inReplyTo: '<irt-b@owlat.test>',
			receivedAt: t0 + 6 * DAY,
		});
		const second = await deliver(t, mailboxId, {
			from: ME,
			to: [ALICE],
			subject: 'Re: Plan',
			messageId: '<irt-b@owlat.test>',
			inReplyTo: '<irt-a@example.com>',
			receivedAt: t0 + 3 * DAY,
		});
		const root = await deliver(t, mailboxId, {
			from: ALICE,
			to: [ME],
			subject: 'Plan',
			messageId: '<irt-a@example.com>',
			receivedAt: t0,
		});
		expect(second).toBe(third);
		expect(root).toBe(third);
	});

	it('keeps two replies to a root the mailbox does not hold together', async () => {
		const { t, mailboxId } = await setup();
		const t0 = Date.now() - 30 * DAY;
		const fromAlice = await deliver(t, mailboxId, {
			from: ALICE,
			to: [ME, BOB],
			subject: 'Re: Offsite',
			messageId: '<sib-alice@example.com>',
			inReplyTo: '<sib-root@example.com>',
			references: '<sib-root@example.com>',
			receivedAt: t0 + 5 * DAY,
		});
		const fromBob = await deliver(t, mailboxId, {
			from: BOB,
			to: [ME, ALICE],
			subject: 'Re: Offsite',
			messageId: '<sib-bob@example.com>',
			inReplyTo: '<sib-root@example.com>',
			references: '<sib-root@example.com>',
			receivedAt: t0 + DAY,
		});
		expect(fromBob).toBe(fromAlice);
	});

	it('does not pull an unrelated message into a thread', async () => {
		const { t, mailboxId } = await setup();
		const t0 = Date.now() - 30 * DAY;
		const reply = await deliver(t, mailboxId, {
			from: ALICE,
			to: [ME],
			subject: 'Re: Plan',
			messageId: '<u-reply@example.com>',
			inReplyTo: '<u-root@example.com>',
			references: '<u-root@example.com>',
			receivedAt: t0 + 5 * DAY,
		});
		const unrelated = await deliver(t, mailboxId, {
			from: ALICE,
			to: [ME],
			subject: 'Plan',
			messageId: '<u-other@example.com>',
			receivedAt: t0,
		});
		expect(unrelated).not.toBe(reply);
	});
});

describe('IMAP APPEND threading', () => {
	it("files a desktop client's Sent copy of a reply into the conversation", async () => {
		const { t, mailboxId } = await setup();
		const t0 = Date.now() - 3 * DAY;
		const threadId = await deliver(t, mailboxId, {
			from: ALICE,
			to: [ME],
			subject: 'Plan',
			messageId: '<ap-root@example.com>',
			receivedAt: t0,
		});

		const sent = await append(t, mailboxId, 'sent', {
			messageId: 'ap-reply@owlat.test',
			inReplyTo: 'ap-root@example.com',
			references: ['ap-root@example.com'],
			internalDate: t0 + DAY,
		});
		expect(sent).toBe(threadId);

		// Alice's answer references the Sent copy first; it stays in the thread.
		const answer = await deliver(t, mailboxId, {
			from: ALICE,
			to: [ME],
			subject: 'Re: Plan',
			messageId: '<ap-answer@example.com>',
			inReplyTo: '<ap-reply@owlat.test>',
			references: '<ap-root@example.com> <ap-reply@owlat.test>',
			receivedAt: t0 + 2 * DAY,
		});
		expect(answer).toBe(threadId);

		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread?.messageCount).toBe(3);
		expect(thread?.folderRoles).toEqual(expect.arrayContaining(['inbox', 'sent']));
	});

	it('keeps a draft APPEND in a thread of its own', async () => {
		const { t, mailboxId } = await setup();
		const t0 = Date.now() - 3 * DAY;
		const threadId = await deliver(t, mailboxId, {
			from: ALICE,
			to: [ME],
			subject: 'Plan',
			messageId: '<dr-root@example.com>',
			receivedAt: t0,
		});
		const draft = await append(t, mailboxId, 'drafts', {
			messageId: 'dr-draft@owlat.test',
			inReplyTo: 'dr-root@example.com',
			references: ['dr-root@example.com'],
			internalDate: t0 + DAY,
		});
		expect(draft).not.toBe(threadId);
		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread?.messageCount).toBe(1);
	});
});
