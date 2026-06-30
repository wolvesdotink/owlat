/**
 * Snooze hides-from-inbox coverage.
 *
 * Regression guard for the bug where `snoozedUntil` was written but no list
 * query filtered on it, so snoozed mail never actually left the inbox.
 *   - listMessages(inbox) excludes still-snoozed rows
 *   - listMessages(snoozed) returns ONLY still-snoozed rows
 *   - the wakeup cron clears the flag so the row re-floats into its folder
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

async function seedMessage(
	t: ReturnType<typeof convexTest>,
	opts: {
		mailboxId: Id<'mailboxes'>;
		folderId: Id<'mailFolders'>;
		subject: string;
		snoozedUntil?: number;
	}
): Promise<Id<'mailMessages'>> {
	let id!: Id<'mailMessages'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		const storageId = await ctx.storage.store(new Blob([opts.subject]));
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId: opts.mailboxId,
			normalizedSubject: opts.subject.toLowerCase(),
			participants: ['alice@example.com'],
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
		id = await ctx.db.insert('mailMessages', {
			mailboxId: opts.mailboxId,
			folderId: opts.folderId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: `<${opts.subject}@example.com>`,
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
			snoozedUntil: opts.snoozedUntil,
			receivedAt: now,
			internalDate: now,
			createdAt: now,
			updatedAt: now,
		});
	});
	return id;
}

async function addMessageToThread(
	t: ReturnType<typeof convexTest>,
	opts: {
		mailboxId: Id<'mailboxes'>;
		folderId: Id<'mailFolders'>;
		threadId: Id<'mailThreads'>;
		subject: string;
		receivedAt: number;
	}
): Promise<Id<'mailMessages'>> {
	let id!: Id<'mailMessages'>;
	await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob([opts.subject]));
		id = await ctx.db.insert('mailMessages', {
			mailboxId: opts.mailboxId,
			folderId: opts.folderId,
			uid: opts.receivedAt,
			modseq: 1,
			rfc822MessageId: `<${opts.subject}@example.com>`,
			threadId: opts.threadId,
			fromAddress: 'alice@example.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: opts.subject,
			normalizedSubject: opts.subject.toLowerCase(),
			snippet: opts.subject,
			rawStorageId: storageId,
			rawSize: 1,
			attachments: [],
			hasAttachments: false,
			flagSeen: true,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			receivedAt: opts.receivedAt,
			internalDate: opts.receivedAt,
			createdAt: opts.receivedAt,
			updatedAt: opts.receivedAt,
		});
	});
	return id;
}

async function seed(t: ReturnType<typeof convexTest>) {
	let mailboxId!: Id<'mailboxes'>;
	let inboxId!: Id<'mailFolders'>;
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
		inboxId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 1,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
	});
	return { mailboxId, inboxId };
}

describe('postbox snooze hide-from-inbox', () => {
	it('hides still-snoozed messages from the inbox and shows them in the Snoozed view', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seed(t);
		const future = Date.now() + 60 * 60 * 1000;
		await seedMessage(t, { mailboxId, folderId: inboxId, subject: 'visible' });
		await seedMessage(t, { mailboxId, folderId: inboxId, subject: 'snoozed', snoozedUntil: future });

		const inbox = await t.query(api.mail.mailbox.listMessages, {
			mailboxId,
			folderRole: 'inbox',
		});
		expect(inbox.messages.map((m) => m.subject)).toEqual(['visible']);

		const snoozed = await t.query(api.mail.mailbox.listMessages, {
			mailboxId,
			folderRole: 'snoozed',
		});
		expect(snoozed.messages.map((m) => m.subject)).toEqual(['snoozed']);
	});

	it('wakeup cron clears snoozedUntil so the message re-floats into the inbox', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seed(t);
		const past = Date.now() - 1000;
		await seedMessage(t, { mailboxId, folderId: inboxId, subject: 'due', snoozedUntil: past });

		await t.mutation(internal.mail.snooze.internalSweep, {});

		const inbox = await t.query(api.mail.mailbox.listMessages, {
			mailboxId,
			folderRole: 'inbox',
		});
		expect(inbox.messages.map((m) => m.subject)).toEqual(['due']);
		const snoozed = await t.query(api.mail.mailbox.listMessages, {
			mailboxId,
			folderRole: 'snoozed',
		});
		expect(snoozed.messages).toEqual([]);
	});

	it('wakeup cron wakes a due message even when the mailbox is full of never-snoozed mail', async () => {
		// Regression: `by_snoozed_until` sorts undefined before all numbers, so a
		// bare lte(now) filled take(100) with never-snoozed rows and woke nothing
		// in any mailbox with >~100 messages.
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seed(t);
		for (let i = 0; i < 150; i++) {
			await seedMessage(t, { mailboxId, folderId: inboxId, subject: `plain-${i}` });
		}
		const past = Date.now() - 1000;
		const dueId = await seedMessage(t, { mailboxId, folderId: inboxId, subject: 'due', snoozedUntil: past });

		const result = await t.mutation(internal.mail.snooze.internalSweep, {});
		expect(result.woken).toBe(1);
		expect((await t.run((ctx) => ctx.db.get(dueId)))?.snoozedUntil).toBeUndefined();
	});

	it('snooze decrements and wake re-increments the folder unread count', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seed(t);
		const msgId = await seedMessage(t, { mailboxId, folderId: inboxId, subject: 'x' });
		await t.run(async (ctx) => {
			await ctx.db.patch(inboxId, { unseenCount: 1 });
		});

		await t.mutation(api.mail.snooze.snooze, {
			messageId: msgId,
			until: Date.now() + 60 * 60 * 1000,
		});
		expect((await t.run((ctx) => ctx.db.get(inboxId)))?.unseenCount).toBe(0);

		// Force it due, then wake it via the cron.
		await t.run(async (ctx) => {
			await ctx.db.patch(msgId, { snoozedUntil: Date.now() - 1000 });
		});
		await t.mutation(internal.mail.snooze.internalSweep, {});
		expect((await t.run((ctx) => ctx.db.get(inboxId)))?.unseenCount).toBe(1);
	});

	it('moving a snoozed unread message does not corrupt either folder count', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seed(t);
		let archiveId!: Id<'mailFolders'>;
		await t.run(async (ctx) => {
			const now = Date.now();
			archiveId = await ctx.db.insert('mailFolders', {
				mailboxId,
				name: 'Archive',
				role: 'archive',
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.patch(inboxId, { unseenCount: 1 });
		});
		const msgId = await seedMessage(t, { mailboxId, folderId: inboxId, subject: 'm' });

		await t.mutation(api.mail.snooze.snooze, {
			messageId: msgId,
			until: Date.now() + 60 * 60 * 1000,
		});
		expect((await t.run((ctx) => ctx.db.get(inboxId)))?.unseenCount).toBe(0);

		expect(
			await t.mutation(api.mail.messageActions.move, {
				messageIds: [msgId],
				targetFolderId: archiveId,
			})
		).toEqual({ ok: true });
		// Snoozed message wasn't counted in either folder, so the move shifts nothing.
		expect((await t.run((ctx) => ctx.db.get(inboxId)))?.unseenCount).toBe(0);
		expect((await t.run((ctx) => ctx.db.get(archiveId)))?.unseenCount).toBe(0);
	});

	it('latestInboxUnread returns the newest unread, not-snoozed message', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seed(t);
		// older unread, a snoozed newer one, and the newest unread
		await seedMessage(t, { mailboxId, folderId: inboxId, subject: 'older' });
		await seedMessage(t, {
			mailboxId,
			folderId: inboxId,
			subject: 'snoozed-newer',
			snoozedUntil: Date.now() + 60 * 60 * 1000,
		});
		const newestId = await seedMessage(t, { mailboxId, folderId: inboxId, subject: 'newest' });
		// Make ordering deterministic by receivedAt.
		await t.run(async (ctx) => {
			await ctx.db.patch(newestId, { receivedAt: Date.now() + 1000 });
		});

		const latest = await t.query(api.mail.mailbox.latestInboxUnread, {});
		expect(latest?.messageId).toBe(newestId);
		expect(latest?.subject).toBe('newest');
	});

	it('latestInboxUnread returns null when nothing is unread', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seed(t);
		const id = await seedMessage(t, { mailboxId, folderId: inboxId, subject: 'read' });
		await t.run(async (ctx) => {
			await ctx.db.patch(id, { flagSeen: true });
		});
		expect(await t.query(api.mail.mailbox.latestInboxUnread, {})).toBeNull();
	});

	it('purging the newest thread message re-derives latestMessageId to the next', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seed(t);
		const now = Date.now();
		let threadId!: Id<'mailThreads'>;
		await t.run(async (ctx) => {
			threadId = await ctx.db.insert('mailThreads', {
				mailboxId,
				normalizedSubject: 'thread',
				participants: ['alice@example.com'],
				messageCount: 2,
				unreadCount: 0,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now + 1000,
				firstMessageAt: now,
				latestSnippet: 'B',
				latestFromAddress: 'alice@example.com',
				latestSubject: 'B',
				folderRoles: ['inbox'],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
		});
		const msgA = await addMessageToThread(t, { mailboxId, folderId: inboxId, threadId, subject: 'A', receivedAt: now });
		const msgB = await addMessageToThread(t, { mailboxId, folderId: inboxId, threadId, subject: 'B', receivedAt: now + 1000 });
		await t.run((ctx) => ctx.db.patch(threadId, { latestMessageId: msgB }));

		await t.mutation(api.mail.messageActions.purge, { messageIds: [msgB] });

		const thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.latestMessageId).toBe(msgA);
		expect(thread?.messageCount).toBe(1);
	});

	it('re-snoozing an already-snoozed message does not double-decrement the count', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seed(t);
		const m1 = await seedMessage(t, { mailboxId, folderId: inboxId, subject: 'a' });
		await seedMessage(t, { mailboxId, folderId: inboxId, subject: 'b' });
		await t.run((ctx) => ctx.db.patch(inboxId, { unseenCount: 2 }));

		await t.mutation(api.mail.snooze.snooze, { messageId: m1, until: Date.now() + 60 * 60 * 1000 });
		expect((await t.run((ctx) => ctx.db.get(inboxId)))?.unseenCount).toBe(1);
		// Snooze the SAME message again — the alreadySnoozed guard must hold.
		await t.mutation(api.mail.snooze.snooze, { messageId: m1, until: Date.now() + 2 * 60 * 60 * 1000 });
		expect((await t.run((ctx) => ctx.db.get(inboxId)))?.unseenCount).toBe(1);
	});

	it('reports hasMore when a folder has more than one page', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seed(t);
		for (let i = 0; i < 3; i++) {
			await seedMessage(t, { mailboxId, folderId: inboxId, subject: `m${i}` });
		}
		const page = await t.query(api.mail.mailbox.listMessages, {
			mailboxId,
			folderRole: 'inbox',
			limit: 2,
		});
		expect(page.messages.length).toBe(2);
		expect(page.hasMore).toBe(true);

		const full = await t.query(api.mail.mailbox.listMessages, {
			mailboxId,
			folderRole: 'inbox',
			limit: 50,
		});
		expect(full.messages.length).toBe(3);
		expect(full.hasMore).toBe(false);
	});
});
