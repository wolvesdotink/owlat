/**
 * mail.mailbox.listThreads — the conversation (thread-grouped) inbox view.
 * Returns threads whose folderRoles include the folder, newest first, hiding
 * threads whose latest message is snoozed.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
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
		!path.includes('llmProvider')
	)
);

async function seedThread(t: ReturnType<typeof convexTest>, folderRoles: string[]) {
	let mailboxId!: Id<'mailboxes'>;
	let messageId!: Id<'mailMessages'>;
	let threadId!: Id<'mailThreads'>;
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
		const inboxId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 1,
			totalCount: 1,
			unseenCount: 1,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'hi',
			participants: ['a@example.com'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'hello',
			latestFromAddress: 'a@example.com',
			latestSubject: 'hi',
			folderRoles,
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const storageId = await ctx.storage.store(new Blob(['x']));
		messageId = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId: inboxId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<m@example.com>',
			threadId,
			fromAddress: 'a@example.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'hi',
			normalizedSubject: 'hi',
			snippet: 'hello',
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
		await ctx.db.patch(threadId, { latestMessageId: messageId });
	});
	return { mailboxId, messageId, threadId };
}

describe('mail.mailbox.listThreads', () => {
	it('returns inbox threads, hiding non-inbox ones', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedThread(t, ['inbox']);
		const res = await t.query(api.mail.mailbox.listThreads, { mailboxId, folderRole: 'inbox' });
		expect(res.threads).toHaveLength(1);
		const sent = await t.query(api.mail.mailbox.listThreads, { mailboxId, folderRole: 'sent' });
		expect(sent.threads).toHaveLength(0);
	});

	it('hides a thread whose latest message is snoozed', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId } = await seedThread(t, ['inbox']);
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { snoozedUntil: Date.now() + 60 * 60 * 1000 });
		});
		const res = await t.query(api.mail.mailbox.listThreads, { mailboxId, folderRole: 'inbox' });
		expect(res.threads).toHaveLength(0);
	});
});
