/**
 * "Remind me if no reply" follow-up tracking (mail/followUps.ts).
 *
 *   - arm() stores the watch on the sent message's thread
 *   - an inbound reply delivered into the thread BEFORE the deadline clears
 *     the watch silently (delivery.deliverToMailbox wiring)
 *   - the sweep cron resurfaces a past-deadline watch EXACTLY once: watched
 *     message back in the Inbox, unread + flagged, thread floated to the top,
 *     followUp.dueAt stamped (which feeds the Reply Queue follow-up item)
 *   - cancel() clears an armed or due watch
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') &&
		!path.includes('agentSecurity') &&
		!path.includes('agentContext') &&
		!path.includes('llmProvider')
	)
);

interface Seeded {
	mailboxId: Id<'mailboxes'>;
	inboxId: Id<'mailFolders'>;
	sentId: Id<'mailFolders'>;
}

async function seed(t: ReturnType<typeof convexTest>): Promise<Seeded> {
	let mailboxId!: Id<'mailboxes'>;
	let inboxId!: Id<'mailFolders'>;
	let sentId!: Id<'mailFolders'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: 'me@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const folder = (name: string, role: 'inbox' | 'sent') =>
			ctx.db.insert('mailFolders', {
				mailboxId,
				name,
				role,
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		inboxId = await folder('INBOX', 'inbox');
		sentId = await folder('Sent', 'sent');
	});
	return { mailboxId, inboxId, sentId };
}

/** Seed a sent (owner-outbound) message + its thread; returns both ids. */
async function seedSentMessage(
	t: ReturnType<typeof convexTest>,
	seeded: Seeded,
	opts: { subject: string; to?: string },
): Promise<{ messageId: Id<'mailMessages'>; threadId: Id<'mailThreads'> }> {
	let messageId!: Id<'mailMessages'>;
	let threadId!: Id<'mailThreads'>;
	const to = opts.to ?? 'alice@example.com';
	await t.run(async (ctx) => {
		const now = Date.now();
		const storageId = await ctx.storage.store(new Blob([opts.subject]));
		threadId = await ctx.db.insert('mailThreads', {
			mailboxId: seeded.mailboxId,
			normalizedSubject: opts.subject.toLowerCase(),
			participants: ['me@example.com', to],
			messageCount: 1,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: opts.subject,
			latestFromAddress: 'me@example.com',
			latestSubject: opts.subject,
			folderRoles: ['sent'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		messageId = await ctx.db.insert('mailMessages', {
			mailboxId: seeded.mailboxId,
			folderId: seeded.sentId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: `<${opts.subject}@example.com>`,
			threadId,
			fromAddress: 'me@example.com',
			toAddresses: [to],
			ccAddresses: [],
			bccAddresses: [],
			subject: opts.subject,
			normalizedSubject: opts.subject.toLowerCase(),
			snippet: opts.subject,
			rawStorageId: storageId,
			rawSize: opts.subject.length,
			attachments: [],
			hasAttachments: false,
			flagSeen: true,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			outbound: { state: 'sent', recipients: [] },
			receivedAt: now,
			internalDate: now,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(threadId, { latestMessageId: messageId });
	});
	return { messageId, threadId };
}

/** Deliver an inbound reply into the mailbox via the real delivery mutation. */
async function deliverInboundReply(
	t: ReturnType<typeof convexTest>,
	opts: { subject: string; rfcMessageId: string; inReplyTo?: string },
) {
	const rawStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['raw'])));
	return t.mutation(internal.mail.delivery.deliverToMailbox, {
		rawStorageId,
		rawSize: 3,
		recipientAddress: 'me@example.com',
		from: 'alice@example.com',
		to: ['me@example.com'],
		cc: [],
		bcc: [],
		subject: opts.subject,
		textBodyInline: 'sounds good!',
		snippet: 'sounds good!',
		messageId: opts.rfcMessageId,
		inReplyTo: opts.inReplyTo,
		receivedAt: Date.now(),
		attachments: [],
	});
}

describe('postbox follow-up reminders', () => {
	it('arm() stores the watch on the thread with the sweep key', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { messageId, threadId } = await seedSentMessage(t, seeded, { subject: 'proposal' });
		const remindAt = Date.now() + 60 * 60 * 1000;

		await t.mutation(api.mail.followUps.arm, { messageId, remindAt });

		const thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.followUp).toMatchObject({
			messageId,
			remindAt,
			waitingOn: 'alice@example.com',
		});
		expect(thread?.followUp?.dueAt).toBeUndefined();
		expect(thread?.followUpRemindAt).toBe(remindAt);
	});

	it('an inbound reply before the deadline clears the watch silently', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { messageId, threadId } = await seedSentMessage(t, seeded, { subject: 'proposal' });
		await t.mutation(api.mail.followUps.arm, {
			messageId,
			remindAt: Date.now() + 60 * 60 * 1000,
		});

		// Same normalized subject → the delivery threads onto the sent thread.
		const result = await deliverInboundReply(t, {
			subject: 'Re: proposal',
			rfcMessageId: '<reply-1@isp.example>',
			inReplyTo: '<proposal@example.com>',
		});
		expect('messageId' in result).toBe(true);

		const thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.followUp).toBeUndefined();
		expect(thread?.followUpRemindAt).toBeUndefined();

		// A cleared watch never fires: the sweep is a no-op.
		const sweep = await t.mutation(internal.mail.followUps.internalSweep, {});
		expect(sweep.resurfaced).toBe(0);
	});

	it('sweep past the deadline resurfaces the thread (inbox, unread, flagged) exactly once', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { messageId, threadId } = await seedSentMessage(t, seeded, { subject: 'proposal' });
		await t.mutation(api.mail.followUps.arm, {
			messageId,
			remindAt: Date.now() + 60 * 60 * 1000,
		});
		// Force the deadline into the past (arm() rejects a past remindAt).
		await t.run(async (ctx) => {
			const thread = await ctx.db.get(threadId);
			const past = Date.now() - 1000;
			await ctx.db.patch(threadId, {
				followUp: { ...thread!.followUp!, remindAt: past },
				followUpRemindAt: past,
			});
		});

		const sweep = await t.mutation(internal.mail.followUps.internalSweep, {});
		expect(sweep.resurfaced).toBe(1);

		const message = await t.run((ctx) => ctx.db.get(messageId));
		expect(message?.folderId).toBe(seeded.inboxId);
		expect(message?.flagSeen).toBe(false);
		expect(message?.flagFlagged).toBe(true);

		const thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.followUp?.dueAt).toBeGreaterThan(0);
		expect(thread?.followUpRemindAt).toBeUndefined();

		// Folder counters moved with the message.
		const inbox = await t.run((ctx) => ctx.db.get(seeded.inboxId));
		expect(inbox?.totalCount).toBe(1);
		expect(inbox?.unseenCount).toBe(1);
		const sent = await t.run((ctx) => ctx.db.get(seeded.sentId));
		expect(sent?.totalCount).toBe(0);

		// The due watch feeds the Reply Queue as a follow-up item.
		const queue = await t.query(api.mail.needsReply.listQueue, {
			mailboxId: seeded.mailboxId,
		});
		expect(queue.items).toHaveLength(1);
		expect(queue.items[0]).toMatchObject({
			kind: 'followup',
			threadId,
			messageId,
			waitingOn: 'alice@example.com',
		});

		// EXACTLY once: a second sweep does nothing.
		const again = await t.mutation(internal.mail.followUps.internalSweep, {});
		expect(again.resurfaced).toBe(0);
		expect((await t.run((ctx) => ctx.db.get(seeded.inboxId)))?.unseenCount).toBe(1);
	});

	it('cancel() clears an armed watch, and dismisses a due one from the queue', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { messageId, threadId } = await seedSentMessage(t, seeded, { subject: 'proposal' });
		await t.mutation(api.mail.followUps.arm, {
			messageId,
			remindAt: Date.now() + 60 * 60 * 1000,
		});

		await t.mutation(api.mail.followUps.cancel, { threadId });
		let thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.followUp).toBeUndefined();
		expect(thread?.followUpRemindAt).toBeUndefined();

		// Re-arm, force due, sweep, then dismiss the due chip.
		await t.mutation(api.mail.followUps.arm, {
			messageId,
			remindAt: Date.now() + 60 * 60 * 1000,
		});
		await t.run(async (ctx) => {
			const tRow = await ctx.db.get(threadId);
			const past = Date.now() - 1000;
			await ctx.db.patch(threadId, {
				followUp: { ...tRow!.followUp!, remindAt: past },
				followUpRemindAt: past,
			});
		});
		await t.mutation(internal.mail.followUps.internalSweep, {});
		await t.mutation(api.mail.followUps.cancel, { threadId });

		thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.followUp).toBeUndefined();
		const queue = await t.query(api.mail.needsReply.listQueue, {
			mailboxId: seeded.mailboxId,
		});
		expect(queue.items).toHaveLength(0);
	});

	it('arm() rejects a non-outbound (received) message', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		// Seed an inbound message in the inbox (no outbound marker).
		let messageId!: Id<'mailMessages'>;
		await t.run(async (ctx) => {
			const now = Date.now();
			const storageId = await ctx.storage.store(new Blob(['x']));
			const threadId = await ctx.db.insert('mailThreads', {
				mailboxId: seeded.mailboxId,
				normalizedSubject: 'hi',
				participants: ['alice@example.com'],
				messageCount: 1,
				unreadCount: 1,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now,
				firstMessageAt: now,
				latestSnippet: 'hi',
				latestFromAddress: 'alice@example.com',
				latestSubject: 'hi',
				folderRoles: ['inbox'],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
			messageId = await ctx.db.insert('mailMessages', {
				mailboxId: seeded.mailboxId,
				folderId: seeded.inboxId,
				uid: 1,
				modseq: 1,
				rfc822MessageId: '<hi@isp.example>',
				threadId,
				fromAddress: 'alice@example.com',
				toAddresses: ['me@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'hi',
				normalizedSubject: 'hi',
				snippet: 'hi',
				rawStorageId: storageId,
				rawSize: 1,
				attachments: [],
				hasAttachments: false,
				flagSeen: false,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: [],
				receivedAt: now,
				internalDate: now,
				createdAt: now,
				updatedAt: now,
			});
		});

		await expect(
			t.mutation(api.mail.followUps.arm, {
				messageId,
				remindAt: Date.now() + 60 * 60 * 1000,
			})
		).rejects.toThrow();
	});
});
