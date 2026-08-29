/**
 * Conversation mute (mail/mute.ts + the four places that read `mutedAt`):
 *   - setMutedForMessage stamps the marker AND archives the mail already in the
 *     Inbox
 *   - new inbound mail on a muted thread is delivered straight to Archive
 *     (deliveryPipeline/insert.ts → redirectMutedDelivery), never the Inbox
 *   - a muted thread is excluded from the Reply Queue and from the
 *     needs-reply enqueue
 *   - newestUnreadInbox marks the row `muted` so the desktop notifier can
 *     stay silent
 *   - the list-row projection carries `mutedAt` for the chip
 *   - unmuting clears the marker and does NOT un-archive what mute filed
 *   - it refuses a mailbox the caller does not own, either direction
 *
 * Plus its opt-in twin, the per-thread reply alert (mail/threadAlerts.ts):
 * the marker, its `alerted` flag on the unread peek, and the invariant that
 * arming one clears the other.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

const sessionMock = vi.hoisted(() => ({
	userId: 'test-user',
	role: 'owner' as 'owner' | 'editor',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
			activeOrganizationId: 'test-org',
		})),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('llmProvider')
	)
);

interface Seeded {
	mailboxId: Id<'mailboxes'>;
	inboxId: Id<'mailFolders'>;
	archiveId: Id<'mailFolders'>;
}

async function seed(t: ReturnType<typeof convexTest>): Promise<Seeded> {
	let mailboxId!: Id<'mailboxes'>;
	let inboxId!: Id<'mailFolders'>;
	let archiveId!: Id<'mailFolders'>;
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
		const folder = (name: string, role: 'inbox' | 'archive') =>
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
		archiveId = await folder('Archive', 'archive');
	});
	return { mailboxId, inboxId, archiveId };
}

/** Seed one inbound thread with a single inbox message. */
async function seedThread(
	t: ReturnType<typeof convexTest>,
	seeded: Seeded,
	opts: { subject: string; rfcMessageId: string }
): Promise<{ threadId: Id<'mailThreads'>; messageId: Id<'mailMessages'> }> {
	let threadId!: Id<'mailThreads'>;
	let messageId!: Id<'mailMessages'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		const storageId = await ctx.storage.store(new Blob([opts.subject]));
		threadId = await ctx.db.insert('mailThreads', {
			mailboxId: seeded.mailboxId,
			normalizedSubject: opts.subject.toLowerCase(),
			participants: ['alice@example.com', 'me@example.com'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: opts.subject,
			latestFromAddress: 'alice@example.com',
			latestSubject: opts.subject,
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
			rfc822MessageId: opts.rfcMessageId,
			threadId,
			fromAddress: 'alice@example.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: opts.subject,
			normalizedSubject: opts.subject.toLowerCase(),
			snippet: opts.subject,
			rawStorageId: storageId,
			rawSize: opts.subject.length,
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
		await ctx.db.patch(threadId, { latestMessageId: messageId });
		await ctx.db.patch(seeded.inboxId, { totalCount: 1, unseenCount: 1 });
	});
	return { threadId, messageId };
}

/** Deliver an inbound message through the real delivery mutation. */
async function deliverInbound(
	t: ReturnType<typeof convexTest>,
	opts: { subject: string; rfcMessageId: string; inReplyTo?: string }
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
		textBodyInline: 'more chatter',
		snippet: 'more chatter',
		messageId: opts.rfcMessageId,
		inReplyTo: opts.inReplyTo,
		receivedAt: Date.now(),
		attachments: [],
	});
}

describe('conversation mute', () => {
	it('mute stamps the marker and archives the inbox mail already on the thread', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { threadId, messageId } = await seedThread(t, seeded, {
			subject: 'loud thread',
			rfcMessageId: 'loud-1@example.com',
		});

		expect(await t.mutation(api.mail.mute.setMutedForMessage, { messageId, muted: true })).toEqual({
			ok: true,
			threadId,
		});

		const thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.mutedAt).toBeGreaterThan(0);
		expect((await t.run((ctx) => ctx.db.get(messageId)))?.folderId).toBe(seeded.archiveId);
		const inbox = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId: seeded.mailboxId,
			folderRole: 'inbox',
		});
		expect(inbox.messages).toEqual([]);
	});

	it('new inbound mail on a muted thread lands in Archive, not the Inbox', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { threadId, messageId } = await seedThread(t, seeded, {
			subject: 'loud thread',
			rfcMessageId: 'loud-1@example.com',
		});
		await t.mutation(api.mail.mute.setMutedForMessage, { messageId, muted: true });

		await deliverInbound(t, {
			subject: 'Re: loud thread',
			rfcMessageId: '<loud-2@example.com>',
			inReplyTo: '<loud-1@example.com>',
		});

		const inbox = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId: seeded.mailboxId,
			folderRole: 'inbox',
		});
		expect(inbox.messages).toEqual([]);
		const archived = await t.run(async (ctx) =>
			ctx.db
				.query('mailMessages')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.collect()
		);
		expect(archived).toHaveLength(2);
		expect(archived.every((m) => m.folderId === seeded.archiveId)).toBe(true);
	});

	it('unmuting lets the next delivery reach the inbox again (and keeps the archived mail filed)', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { threadId, messageId } = await seedThread(t, seeded, {
			subject: 'loud thread',
			rfcMessageId: 'loud-1@example.com',
		});
		await t.mutation(api.mail.mute.setMutedForMessage, { messageId, muted: true });
		await t.mutation(api.mail.mute.setMutedForMessage, { messageId, muted: false });

		expect((await t.run((ctx) => ctx.db.get(threadId)))?.mutedAt).toBeUndefined();
		// The mail the mute filed stays filed — unmute is not an un-archive.
		expect((await t.run((ctx) => ctx.db.get(messageId)))?.folderId).toBe(seeded.archiveId);

		await deliverInbound(t, {
			subject: 'Re: loud thread',
			rfcMessageId: '<loud-3@example.com>',
			inReplyTo: '<loud-1@example.com>',
		});
		const inbox = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId: seeded.mailboxId,
			folderRole: 'inbox',
		});
		expect(inbox.messages.map((m) => m.subject)).toEqual(['Re: loud thread']);
	});

	it('a muted thread never appears in the Reply Queue', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { threadId, messageId } = await seedThread(t, seeded, {
			subject: 'needs an answer',
			rfcMessageId: 'ask-1@example.com',
		});
		await t.run((ctx) =>
			ctx.db.patch(threadId, {
				needsReply: {
					messageId,
					detectedAt: Date.now(),
					source: 'heuristic',
					urgency: 'normal',
				},
			})
		);
		expect(
			(await t.query(api.mail.needsReply.listQueue, { mailboxId: seeded.mailboxId })).items
		).toHaveLength(1);

		await t.mutation(api.mail.mute.setMutedForMessage, { messageId, muted: true });

		// Mute clears the flag outright, and the read skips it belt-and-braces.
		expect((await t.run((ctx) => ctx.db.get(threadId)))?.needsReply).toBeUndefined();
		expect(
			(await t.query(api.mail.needsReply.listQueue, { mailboxId: seeded.mailboxId })).items
		).toEqual([]);
	});

	it('a thread muted AFTER it was flagged still drops out of the Reply Queue on the next read', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { threadId, messageId } = await seedThread(t, seeded, {
			subject: 'needs an answer',
			rfcMessageId: 'ask-1@example.com',
		});
		// Mute first, then re-flag directly (simulating a classification that was
		// already in flight when the mute landed).
		await t.mutation(api.mail.mute.setMutedForMessage, { messageId, muted: true });
		await t.run((ctx) =>
			ctx.db.patch(threadId, {
				needsReply: {
					messageId,
					detectedAt: Date.now(),
					source: 'llm',
					urgency: 'high',
				},
			})
		);
		expect(
			(await t.query(api.mail.needsReply.listQueue, { mailboxId: seeded.mailboxId })).items
		).toEqual([]);
	});

	it('newestUnreadInbox flags a muted thread so the desktop notifier can stay silent', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { threadId } = await seedThread(t, seeded, {
			subject: 'loud thread',
			rfcMessageId: 'loud-1@example.com',
		});
		expect((await t.query(api.mail.mailbox.queries.newestUnreadInbox, {})).messages[0]?.muted).toBe(
			false
		);

		// Mute without the archive step so the message stays an unread inbox row.
		await t.run((ctx) => ctx.db.patch(threadId, { mutedAt: Date.now() }));
		expect((await t.query(api.mail.mailbox.queries.newestUnreadInbox, {})).messages[0]?.muted).toBe(
			true
		);
	});

	it('the list-row projection carries mutedAt for the row chip', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { threadId } = await seedThread(t, seeded, {
			subject: 'loud thread',
			rfcMessageId: 'loud-1@example.com',
		});
		await t.run((ctx) => ctx.db.patch(threadId, { mutedAt: 1234 }));
		const inbox = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId: seeded.mailboxId,
			folderRole: 'inbox',
		});
		expect(inbox.messages[0]?.mutedAt).toBe(1234);
	});

	it('refuses to mute a thread in a mailbox the caller has no membership on', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { threadId, messageId } = await seedThread(t, seeded, {
			subject: 'loud thread',
			rfcMessageId: 'loud-1@example.com',
		});
		// A plain org editor with no mailboxMembers row on someone else's mailbox.
		sessionMock.userId = 'someone-else';
		sessionMock.role = 'editor';
		try {
			await expect(
				t.mutation(api.mail.mute.setMutedForMessage, { messageId, muted: true })
			).rejects.toThrow();
			await expect(
				t.mutation(api.mail.mute.setMutedForMessage, { messageId, muted: false })
			).rejects.toThrow();
		} finally {
			sessionMock.userId = 'test-user';
			sessionMock.role = 'owner';
		}
		expect((await t.run((ctx) => ctx.db.get(threadId)))?.mutedAt).toBeUndefined();
	});

	it("setMutedForMessage mutes and unmutes the message's thread", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { threadId, messageId } = await seedThread(t, seeded, {
			subject: 'loud thread',
			rfcMessageId: 'loud-1@example.com',
		});

		expect(await t.mutation(api.mail.mute.setMutedForMessage, { messageId, muted: true })).toEqual({
			ok: true,
			threadId,
		});
		expect((await t.run((ctx) => ctx.db.get(threadId)))?.mutedAt).toBeGreaterThan(0);

		await t.mutation(api.mail.mute.setMutedForMessage, { messageId, muted: false });
		expect((await t.run((ctx) => ctx.db.get(threadId)))?.mutedAt).toBeUndefined();
	});
});

/**
 * Per-thread reply alerts (mail/threadAlerts.ts) — the opt-IN twin of mute:
 * one marker, surfaced on the unread peek, kept mutually exclusive with mute.
 */
describe('per-thread reply alert', () => {
	it('arming stamps the marker and the unread peek reports it', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { threadId, messageId } = await seedThread(t, seeded, {
			subject: 'watch this one',
			rfcMessageId: 'watch-1@example.com',
		});
		expect(
			(await t.query(api.mail.mailbox.queries.newestUnreadInbox, {})).messages[0]?.alerted
		).toBe(false);

		expect(
			await t.mutation(api.mail.threadAlerts.setNotifyOnReplyForMessage, {
				messageId,
				enabled: true,
			})
		).toEqual({ ok: true, threadId });
		expect((await t.run((ctx) => ctx.db.get(threadId)))?.notifyOnReplyAt).toBeGreaterThan(0);
		expect(
			(await t.query(api.mail.mailbox.queries.newestUnreadInbox, {})).messages[0]?.alerted
		).toBe(true);
	});

	it('disarming drops the marker again', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { threadId, messageId } = await seedThread(t, seeded, {
			subject: 'watch this one',
			rfcMessageId: 'watch-1@example.com',
		});
		await t.mutation(api.mail.threadAlerts.setNotifyOnReplyForMessage, {
			messageId,
			enabled: true,
		});
		await t.mutation(api.mail.threadAlerts.setNotifyOnReplyForMessage, {
			messageId,
			enabled: false,
		});
		expect((await t.run((ctx) => ctx.db.get(threadId)))?.notifyOnReplyAt).toBeUndefined();
	});

	it('alert and mute are mutually exclusive in both directions', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { threadId, messageId } = await seedThread(t, seeded, {
			subject: 'watch this one',
			rfcMessageId: 'watch-1@example.com',
		});

		// Arming an alert on a muted thread lifts the mute — a conversation that
		// is both silenced and shouting is a state the user cannot make sense of.
		await t.mutation(api.mail.mute.setMutedForMessage, { messageId, muted: true });
		await t.mutation(api.mail.threadAlerts.setNotifyOnReplyForMessage, {
			messageId,
			enabled: true,
		});
		let thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.mutedAt).toBeUndefined();
		expect(thread?.notifyOnReplyAt).toBeGreaterThan(0);

		// And muting disarms the alert.
		await t.mutation(api.mail.mute.setMutedForMessage, { messageId, muted: true });
		thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.notifyOnReplyAt).toBeUndefined();
		expect(thread?.mutedAt).toBeGreaterThan(0);
	});

	it('refuses a message in a mailbox the caller has no membership on', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const { threadId, messageId } = await seedThread(t, seeded, {
			subject: 'watch this one',
			rfcMessageId: 'watch-1@example.com',
		});
		sessionMock.userId = 'someone-else';
		sessionMock.role = 'editor';
		try {
			await expect(
				t.mutation(api.mail.threadAlerts.setNotifyOnReplyForMessage, {
					messageId,
					enabled: true,
				})
			).rejects.toThrow();
		} finally {
			sessionMock.userId = 'test-user';
			sessionMock.role = 'owner';
		}
		expect((await t.run((ctx) => ctx.db.get(threadId)))?.notifyOnReplyAt).toBeUndefined();
	});
});
