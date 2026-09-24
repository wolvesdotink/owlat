/**
 * Delivery threading (issue #817): which `mailThreads` row a delivered message
 * joins.
 *
 * `insertDeliveredMessage` is the one threading step for every inbound path
 * (hosted MX, external IMAP sync, archive import, the brief email). A
 * References / In-Reply-To hit decides the thread. The subject fallback used to
 * attach ANY message to ANY same-subject thread seen in the last 24h, so two
 * near-identical outreach mails to different customers became one thread, and
 * both customers' replies followed them in. The Reply Queue and
 * draft-on-arrival then read one customer's mail as context for the other.
 *
 * These cases pin the tightened fallback: only a message that looks like a
 * reply may use it, it must share an external correspondent with the thread,
 * and it picks the newest qualifying thread rather than the oldest.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { insertDeliveredMessage } from '../deliveryPipeline/insert';
import { modules, seedMailbox, seedFolder } from './helpers.testlib';

const TEAM = 'team@owlat.test';
const ALIAS = 'sales@owlat.test';
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const HOUR = 60 * 60 * 1000;

type Role = 'inbox' | 'sent';

interface Delivered {
	from: string;
	to: string[];
	cc?: string[];
	subject: string;
	messageId: string;
	inReplyTo?: string;
	references?: string;
	receivedAt: number;
	role?: Role;
}

async function setup(): Promise<{ t: TestConvex<typeof schema>; mailboxId: Id<'mailboxes'> }> {
	const t = convexTest(schema, modules);
	const mailboxId = await seedMailbox(t, { address: TEAM, domain: 'owlat.test', scope: 'shared' });
	await seedFolder(t, mailboxId, 'inbox');
	await seedFolder(t, mailboxId, 'sent');
	return { t, mailboxId };
}

/** Run one message through the real insert step; returns its thread id. */
async function deliver(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	msg: Delivered
): Promise<Id<'mailThreads'>> {
	let threadId!: Id<'mailThreads'>;
	await t.run(async (ctx) => {
		const mailbox = await ctx.db.get(mailboxId);
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', mailboxId).eq('role', msg.role ?? 'inbox')
			)
			.first();
		if (!mailbox || !folder) throw new Error('mailbox/folder not seeded');
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const id = await insertDeliveredMessage(ctx, {
			mailbox,
			folder,
			rawStorageId,
			rawSize: 3,
			from: msg.from,
			to: msg.to,
			cc: msg.cc ?? [],
			bcc: [],
			subject: msg.subject,
			textBodyInline: 'body',
			messageId: msg.messageId,
			inReplyTo: msg.inReplyTo,
			references: msg.references,
			receivedAt: msg.receivedAt,
			attachments: [],
		});
		threadId = (await ctx.db.get(id))!.threadId;
	});
	return threadId;
}

async function threadOf(t: TestConvex<typeof schema>, threadId: Id<'mailThreads'>) {
	return t.run(async (ctx) => ctx.db.get(threadId));
}

describe('insertDeliveredMessage threading', () => {
	it('keeps two same-subject outreach conversations with different customers apart', async () => {
		const { t, mailboxId } = await setup();
		const t0 = Date.now() - 2 * HOUR;

		const outAlice = await deliver(t, mailboxId, {
			role: 'sent',
			from: `Team <${TEAM}>`,
			to: [ALICE],
			subject: 'Quick question',
			messageId: '<out-alice@owlat.test>',
			receivedAt: t0,
		});
		const outBob = await deliver(t, mailboxId, {
			role: 'sent',
			from: `Team <${TEAM}>`,
			to: [BOB],
			subject: 'Quick question',
			messageId: '<out-bob@owlat.test>',
			receivedAt: t0 + 10 * 60 * 1000,
		});
		const replyAlice = await deliver(t, mailboxId, {
			from: `Alice <${ALICE}>`,
			to: [TEAM],
			subject: 'Re: Quick question',
			messageId: '<reply-alice@example.com>',
			inReplyTo: '<out-alice@owlat.test>',
			references: '<out-alice@owlat.test>',
			receivedAt: t0 + HOUR,
		});
		const replyBob = await deliver(t, mailboxId, {
			from: `Bob <${BOB}>`,
			to: [TEAM],
			subject: 'Re: Quick question',
			messageId: '<reply-bob@example.com>',
			inReplyTo: '<out-bob@owlat.test>',
			references: '<out-bob@owlat.test>',
			receivedAt: t0 + HOUR + 5 * 60 * 1000,
		});

		expect(outBob).not.toBe(outAlice);
		expect(replyAlice).toBe(outAlice);
		expect(replyBob).toBe(outBob);
		const alice = await threadOf(t, outAlice);
		const bob = await threadOf(t, outBob);
		expect(alice?.messageCount).toBe(2);
		expect(bob?.messageCount).toBe(2);
		expect(alice?.participants).toContain(ALICE);
		expect(alice?.participants).not.toContain(BOB);
		expect(bob?.participants).toContain(BOB);
		expect(bob?.participants).not.toContain(ALICE);
	});

	it('records the recipients of an outbound message as thread participants', async () => {
		const { t, mailboxId } = await setup();
		const threadId = await deliver(t, mailboxId, {
			role: 'sent',
			from: TEAM,
			to: [`Alice <${ALICE}>`],
			cc: [BOB],
			subject: 'Proposal',
			messageId: '<proposal@owlat.test>',
			receivedAt: Date.now(),
		});
		const thread = await threadOf(t, threadId);
		expect(thread?.participants).toEqual(expect.arrayContaining([TEAM, ALICE, BOB]));
	});

	it('still joins a reply without references from the same correspondent within 24h', async () => {
		const { t, mailboxId } = await setup();
		const t0 = Date.now() - 3 * HOUR;
		const first = await deliver(t, mailboxId, {
			role: 'sent',
			from: TEAM,
			to: [ALICE],
			subject: 'Invoice',
			messageId: '<invoice@owlat.test>',
			receivedAt: t0,
		});
		// A client that dropped the threading headers: only the Re: prefix and
		// the correspondent tie it to the conversation.
		const reply = await deliver(t, mailboxId, {
			from: ALICE,
			to: [TEAM],
			subject: 'RE: Invoice',
			messageId: '<no-refs@example.com>',
			receivedAt: t0 + HOUR,
		});
		expect(reply).toBe(first);
	});

	it('joins a reply carrying a localized prefix (AW:) to its conversation', async () => {
		const { t, mailboxId } = await setup();
		const t0 = Date.now() - 3 * HOUR;
		const first = await deliver(t, mailboxId, {
			role: 'sent',
			from: TEAM,
			to: [ALICE],
			subject: 'Invoice',
			messageId: '<invoice-de@owlat.test>',
			receivedAt: t0,
		});
		const reply = await deliver(t, mailboxId, {
			from: ALICE,
			to: [TEAM],
			subject: 'AW: Invoice',
			messageId: '<aw@example.com>',
			receivedAt: t0 + HOUR,
		});
		expect(reply).toBe(first);
	});

	it('does not join a same-subject reply from an unrelated sender', async () => {
		const { t, mailboxId } = await setup();
		const t0 = Date.now() - 3 * HOUR;
		const first = await deliver(t, mailboxId, {
			from: ALICE,
			to: [TEAM],
			subject: 'Vacation cover',
			messageId: '<vac-alice@example.com>',
			receivedAt: t0,
		});
		const other = await deliver(t, mailboxId, {
			from: BOB,
			to: [TEAM],
			subject: 'Re: Vacation cover',
			messageId: '<vac-bob@example.com>',
			receivedAt: t0 + HOUR,
		});
		expect(other).not.toBe(first);
	});

	it('starts a new thread for a fresh message even from the same correspondent', async () => {
		const { t, mailboxId } = await setup();
		const t0 = Date.now() - 3 * HOUR;
		const first = await deliver(t, mailboxId, {
			from: ALICE,
			to: [TEAM],
			subject: 'Weekly report',
			messageId: '<week-1@example.com>',
			receivedAt: t0,
		});
		// No In-Reply-To, no References, no reply prefix: a new conversation.
		const second = await deliver(t, mailboxId, {
			from: ALICE,
			to: [TEAM],
			subject: 'Weekly report',
			messageId: '<week-2@example.com>',
			receivedAt: t0 + HOUR,
		});
		expect(second).not.toBe(first);
	});

	it("treats the mailbox's aliases as its own address, not a shared correspondent", async () => {
		const { t, mailboxId } = await setup();
		await t.run(async (ctx) => {
			await ctx.db.insert('mailAliases', {
				alias: ALIAS,
				targetMailboxId: mailboxId,
				organizationId: 'org-1',
				createdAt: Date.now(),
			});
		});
		const t0 = Date.now() - 3 * HOUR;
		const first = await deliver(t, mailboxId, {
			role: 'sent',
			from: ALIAS,
			to: [ALICE],
			subject: 'Renewal',
			messageId: '<renewal@owlat.test>',
			receivedAt: t0,
		});
		// Bob wrote to the same alias; the alias alone is not a shared party.
		const bob = await deliver(t, mailboxId, {
			from: BOB,
			to: [ALIAS],
			subject: 'Re: Renewal',
			messageId: '<renewal-bob@example.com>',
			receivedAt: t0 + HOUR,
		});
		expect(bob).not.toBe(first);
	});

	it('joins the newest qualifying thread, not the oldest one with that subject', async () => {
		const { t, mailboxId } = await setup();
		const now = Date.now();
		const old = await deliver(t, mailboxId, {
			from: ALICE,
			to: [TEAM],
			subject: 'Status',
			messageId: '<status-old@example.com>',
			receivedAt: now - 72 * HOUR,
		});
		const recent = await deliver(t, mailboxId, {
			from: ALICE,
			to: [TEAM],
			subject: 'Status',
			messageId: '<status-new@example.com>',
			receivedAt: now - 2 * HOUR,
		});
		expect(recent).not.toBe(old);
		const reply = await deliver(t, mailboxId, {
			from: ALICE,
			to: [TEAM],
			subject: 'Re: Status',
			messageId: '<status-reply@example.com>',
			receivedAt: now,
		});
		expect(reply).toBe(recent);
	});
});
