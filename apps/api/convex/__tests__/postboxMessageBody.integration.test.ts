/**
 * mail.mailbox.getMessageBody coverage — the reader's body source.
 *
 * Regression guard for the bug where bodies over the 64KB inline threshold were
 * dropped from the row, so newsletters / long threads rendered blank. Large
 * bodies are now stashed as storage blobs and resolved via signed URLs.
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

async function seedMailboxAndFolder(t: ReturnType<typeof convexTest>) {
	let mailboxId!: Id<'mailboxes'>;
	let folderId!: Id<'mailFolders'>;
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
		folderId = await ctx.db.insert('mailFolders', {
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
	return { mailboxId, folderId };
}

async function insertMessage(
	t: ReturnType<typeof convexTest>,
	mailboxId: Id<'mailboxes'>,
	folderId: Id<'mailFolders'>,
	body: { htmlBodyInline?: string; htmlBodyStorageId?: Id<'_storage'> }
): Promise<Id<'mailMessages'>> {
	let id!: Id<'mailMessages'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 's',
			participants: ['a@example.com'],
			messageCount: 1,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 's',
			latestFromAddress: 'a@example.com',
			latestSubject: 's',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		id = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<m@example.com>',
			threadId,
			fromAddress: 'a@example.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 's',
			normalizedSubject: 's',
			snippet: 's',
			rawStorageId,
			rawSize: 3,
			htmlBodyInline: body.htmlBodyInline,
			htmlBodyStorageId: body.htmlBodyStorageId,
			attachments: [],
			hasAttachments: false,
			flagSeen: true,
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
	return id;
}

describe('mail.mailbox.getMessageBody', () => {
	it('returns the inline body for small messages', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, folderId } = await seedMailboxAndFolder(t);
		const id = await insertMessage(t, mailboxId, folderId, {
			htmlBodyInline: '<p>small</p>',
		});
		const body = await t.query(api.mail.mailbox.getMessageBody, { messageId: id });
		expect(body?.htmlInline).toBe('<p>small</p>');
		expect(body?.htmlUrl).toBeNull();
	});

	it('returns a signed URL for storage-backed large bodies', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, folderId } = await seedMailboxAndFolder(t);
		let storageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			storageId = await ctx.storage.store(
				new Blob(['<p>big</p>'], { type: 'text/html' })
			);
		});
		const id = await insertMessage(t, mailboxId, folderId, { htmlBodyStorageId: storageId });
		const body = await t.query(api.mail.mailbox.getMessageBody, { messageId: id });
		expect(body?.htmlInline).toBeNull();
		expect(body?.htmlUrl).toBeTruthy();
	});
});

describe('mail.mailbox.getMessage (deep-link fallback)', () => {
	it('returns the full message by id for the owner', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, folderId } = await seedMailboxAndFolder(t);
		const id = await insertMessage(t, mailboxId, folderId, { htmlBodyInline: '<p>hi</p>' });
		const msg = await t.query(api.mail.mailbox.getMessage, { messageId: id });
		expect(msg?._id).toBe(id);
		expect(msg?.subject).toBe('s');
	});
});
