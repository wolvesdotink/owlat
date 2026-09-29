/**
 * "The awaited reply arrived" on every inbound path.
 *
 * A thread can carry two watches that wait for the other side to answer:
 * "remind me if no reply" (`mailThreads.followUp`, mail/followUps.ts) and
 * "snooze until they reply" (`isSnoozeUntilReply`, mail/snooze.ts). Both are
 * cleared by the shared post-insert hook
 * (mail/deliveryPipeline/afterInsert.ts::runPostInsertInboundEffects).
 *
 * Only hosted MX delivery used to run the clears, so on a connected Gmail or
 * Fastmail mailbox a synced reply left the reminder armed and the snoozed
 * message hidden until its cap. These cases pin the rule for both paths: a
 * reply from someone else clears both watches; the owner's own Sent copy and
 * a history backfill clear nothing.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

const OWNER = 'me@gmail.example';
const CORRESPONDENT = 'sam@acme.test';
const WATCHED_ID = 'proposal-1@gmail.example';

type Seeded = {
	mailboxId: Id<'mailboxes'>;
	accountId: Id<'externalMailAccounts'>;
	threadId: Id<'mailThreads'>;
	sentMessageId: Id<'mailMessages'>;
};

/**
 * A mailbox whose Sent folder holds the owner's proposal, with a follow-up
 * armed on its thread and the message snoozed until a reply.
 */
async function seedWatchedThread(
	t: TestConvex<typeof schema>,
	kind: 'external' | 'hosted'
): Promise<Seeded> {
	const mailboxId = await seedMailbox(t, {
		address: OWNER,
		domain: 'gmail.example',
		kind,
	});
	for (const role of ['inbox', 'sent', 'archive', 'spam', 'trash'] as const) {
		await seedFolder(t, mailboxId, role);
	}
	const sentMessageId = await seedMessage(t, mailboxId, {
		subject: 'proposal',
		role: 'sent',
		fromAddress: OWNER,
		flagSeen: true,
		rfc822MessageId: WATCHED_ID,
		receivedAt: Date.now() - 60_000,
	});
	let out!: Seeded;
	await t.run(async (ctx) => {
		const now = Date.now();
		const sent = await ctx.db.get(sentMessageId);
		if (!sent) throw new Error('seed failed');
		await ctx.db.patch(sent.threadId, {
			followUp: {
				messageId: sentMessageId,
				remindAt: now + 3_600_000,
				armedAt: now,
				waitingOn: CORRESPONDENT,
			},
			followUpRemindAt: now + 3_600_000,
		});
		await ctx.db.patch(sentMessageId, {
			snoozedUntil: now + 86_400_000,
			snoozedFromFolderId: sent.folderId,
			isSnoozeUntilReply: true,
		});
		const accountId = await ctx.db.insert('externalMailAccounts', {
			userId: 'user-A',
			organizationId: 'org-1',
			mailboxId,
			imapHost: 'imap.gmail.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.gmail.example',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password' as const,
			imapUsername: OWNER,
			secretCiphertext: 'x',
			secretIv: 'x',
			secretAuthTag: 'x',
			secretEnvelopeVersion: 1,
			status: 'connected' as const,
			createdAt: now,
			updatedAt: now,
		});
		out = { mailboxId, accountId, threadId: sent.threadId, sentMessageId };
	});
	return out;
}

/** One synced message threaded onto the watched proposal. */
async function syncReply(
	t: TestConvex<typeof schema>,
	seeded: Seeded,
	opts: {
		origin?: 'sync' | 'backfill';
		folderRole?: 'inbox' | 'sent';
		from?: string;
		to?: string;
	}
): Promise<void> {
	const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['raw'])));
	const outcome = await t.mutation(internal.mail.external.delivery.ingestExternalMessage, {
		accountId: seeded.accountId,
		folderRole: opts.folderRole ?? 'inbox',
		remoteName: opts.folderRole === 'sent' ? 'Sent' : 'INBOX',
		remoteUid: 42,
		remoteUidValidity: 7,
		rawStorageId,
		rawSize: 3,
		from: opts.from ?? `Sam <${CORRESPONDENT}>`,
		to: [opts.to ?? OWNER],
		cc: [],
		bcc: [],
		subject: 'Re: proposal',
		textBodyInline: 'Looks good to me.',
		messageId: '<reply-1@acme.test>',
		inReplyTo: `<${WATCHED_ID}>`,
		receivedAt: Date.now(),
		attachments: [],
		...(opts.origin ? { origin: opts.origin } : {}),
	});
	expect('messageId' in outcome).toBe(true);
}

async function watches(t: TestConvex<typeof schema>, seeded: Seeded) {
	return await t.run(async (ctx) => {
		const thread = await ctx.db.get(seeded.threadId);
		const sent = await ctx.db.get(seeded.sentMessageId);
		const threadMessages = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', seeded.threadId))
			.collect();
		return {
			followUp: thread?.followUp ?? null,
			followUpRemindAt: thread?.followUpRemindAt ?? null,
			snoozedUntilReply: sent?.isSnoozeUntilReply === true,
			threadedMessages: threadMessages.length,
		};
	});
}

/** The classifier enqueues are scheduled, never run — no LLM seam needed. */
async function withHeldScheduler(body: () => Promise<void>): Promise<void> {
	vi.useFakeTimers();
	try {
		await body();
	} finally {
		vi.useRealTimers();
	}
}

describe('external IMAP sync clears reply watches', () => {
	it("a correspondent's reply synced by forward sync clears the follow-up and the snooze", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedWatchedThread(t, 'external');

		await withHeldScheduler(async () => {
			await syncReply(t, seeded, { origin: 'sync' });

			expect(await watches(t, seeded)).toEqual({
				followUp: null,
				followUpRemindAt: null,
				snoozedUntilReply: false,
				threadedMessages: 2,
			});
		});
	});

	it("the owner's own Sent copy, synced from the provider, leaves both watches armed", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedWatchedThread(t, 'external');

		await withHeldScheduler(async () => {
			await syncReply(t, seeded, {
				origin: 'sync',
				folderRole: 'sent',
				from: OWNER,
				to: CORRESPONDENT,
			});

			const after = await watches(t, seeded);
			expect(after.threadedMessages).toBe(2);
			expect(after.followUp).toMatchObject({ messageId: seeded.sentMessageId });
			expect(after.followUpRemindAt).toEqual(expect.any(Number));
			expect(after.snoozedUntilReply).toBe(true);
		});
	});

	it('the owner writing from another client into the inbox is still not a reply', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedWatchedThread(t, 'external');

		await withHeldScheduler(async () => {
			await syncReply(t, seeded, { origin: 'sync', from: OWNER, to: CORRESPONDENT });

			const after = await watches(t, seeded);
			expect(after.followUp).not.toBeNull();
			expect(after.snoozedUntilReply).toBe(true);
		});
	});

	it('a history backfill (or an older worker with no origin) clears nothing', async () => {
		for (const origin of ['backfill', undefined] as const) {
			const t = convexTest(schema, modules);
			const seeded = await seedWatchedThread(t, 'external');

			await withHeldScheduler(async () => {
				await syncReply(t, seeded, origin ? { origin } : {});

				const after = await watches(t, seeded);
				expect(after.threadedMessages).toBe(2);
				expect(after.followUp).not.toBeNull();
				expect(after.snoozedUntilReply).toBe(true);
			});
		}
	});
});

describe('hosted MX delivery clears reply watches', () => {
	async function deliver(t: TestConvex<typeof schema>, from: string) {
		const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['raw'])));
		return await t.mutation(internal.mail.delivery.deliverToMailbox, {
			rawStorageId,
			rawSize: 3,
			recipientAddress: OWNER,
			from,
			to: [OWNER],
			cc: [],
			bcc: [],
			subject: 'Re: proposal',
			textBodyInline: 'Looks good to me.',
			messageId: '<reply-1@acme.test>',
			inReplyTo: `<${WATCHED_ID}>`,
			receivedAt: Date.now(),
			attachments: [],
		});
	}

	it("a correspondent's reply clears the follow-up and the snooze", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedWatchedThread(t, 'hosted');

		await withHeldScheduler(async () => {
			expect('messageId' in (await deliver(t, `Sam <${CORRESPONDENT}>`))).toBe(true);

			const after = await watches(t, seeded);
			expect(after.threadedMessages).toBe(2);
			expect(after.followUp).toBeNull();
			expect(after.snoozedUntilReply).toBe(false);
		});
	});

	it("a copy of the owner's own mail delivered back to them is not a reply", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedWatchedThread(t, 'hosted');

		await withHeldScheduler(async () => {
			expect('messageId' in (await deliver(t, OWNER))).toBe(true);

			const after = await watches(t, seeded);
			expect(after.threadedMessages).toBe(2);
			expect(after.followUp).not.toBeNull();
			expect(after.snoozedUntilReply).toBe(true);
		});
	});
});
