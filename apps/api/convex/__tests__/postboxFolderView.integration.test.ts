/**
 * mail.mailbox.queries.listMessages — the custom-folder (by-id) view that backs custom
 * IMAP / user-created folders in the Postbox sidebar. Returns only the messages
 * in the addressed folder, and enforces that the folder belongs to the mailbox.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { DatabaseWriter } from '../_generated/server';
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
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('llmProvider')
	)
);

async function insertMailbox(
	ctx: { db: DatabaseWriter },
	userId: string
): Promise<Id<'mailboxes'>> {
	const now = Date.now();
	return ctx.db.insert('mailboxes', {
		userId,
		organizationId: 'test-org',
		address: 'me@example.com',
		domain: 'example.com',
		status: 'active',
		usedBytes: 0,
		uidValidity: now,
		createdAt: now,
		updatedAt: now,
	});
}

async function insertFolder(
	ctx: { db: DatabaseWriter },
	mailboxId: Id<'mailboxes'>,
	name: string,
	role?: 'inbox'
): Promise<Id<'mailFolders'>> {
	const now = Date.now();
	return ctx.db.insert('mailFolders', {
		mailboxId,
		name,
		...(role ? { role } : {}),
		uidValidity: now,
		uidNext: 1,
		highestModseq: 1,
		totalCount: 1,
		unseenCount: 1,
		subscribed: true,
		createdAt: now,
		updatedAt: now,
	});
}

async function insertMessage(
	ctx: { db: DatabaseWriter; storage: { store: (b: Blob) => Promise<Id<'_storage'>> } },
	mailboxId: Id<'mailboxes'>,
	folderId: Id<'mailFolders'>,
	subject: string,
	uid: number,
	/** Arrival time — distinct values let the sort-order assertions be exact. */
	receivedAt?: number
): Promise<void> {
	const now = receivedAt ?? Date.now();
	const threadId = await ctx.db.insert('mailThreads', {
		mailboxId,
		normalizedSubject: subject,
		participants: ['a@example.com'],
		messageCount: 1,
		unreadCount: 1,
		hasFlagged: false,
		hasAttachments: false,
		lastMessageAt: now,
		firstMessageAt: now,
		latestSnippet: 'hello',
		latestFromAddress: 'a@example.com',
		latestSubject: subject,
		folderRoles: [],
		labelIds: [],
		createdAt: now,
		updatedAt: now,
	});
	const rawStorageId = await ctx.storage.store(new Blob(['x']));
	await ctx.db.insert('mailMessages', {
		mailboxId,
		folderId,
		threadId,
		uid,
		modseq: uid,
		rfc822MessageId: `<${subject}@example.com>`,
		fromAddress: 'a@example.com',
		toAddresses: ['me@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		subject,
		normalizedSubject: subject,
		snippet: 'hello',
		rawStorageId,
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
}

describe('mail.mailbox.queries.listMessages — custom folder by id', () => {
	it('returns only the messages in the addressed custom folder', async () => {
		const t = convexTest(schema, modules);
		let mailboxId!: Id<'mailboxes'>;
		let customFolderId!: Id<'mailFolders'>;
		await t.run(async (ctx) => {
			mailboxId = await insertMailbox(ctx, 'test-user');
			const inboxId = await insertFolder(ctx, mailboxId, 'INBOX', 'inbox');
			customFolderId = await insertFolder(ctx, mailboxId, 'Receipts');
			await insertMessage(ctx, mailboxId, customFolderId, 'in-custom', 1);
			await insertMessage(ctx, mailboxId, inboxId, 'in-inbox', 2);
		});

		const result = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderId: customFolderId,
		});
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]?.subject).toBe('in-custom');
	});

	it('returns empty for a folder that belongs to a different mailbox', async () => {
		const t = convexTest(schema, modules);
		let mineMailboxId!: Id<'mailboxes'>;
		let otherFolderId!: Id<'mailFolders'>;
		await t.run(async (ctx) => {
			mineMailboxId = await insertMailbox(ctx, 'test-user');
			const otherMailboxId = await insertMailbox(ctx, 'other-user');
			otherFolderId = await insertFolder(ctx, otherMailboxId, 'Theirs');
			await insertMessage(ctx, otherMailboxId, otherFolderId, 'theirs', 1);
		});

		const result = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId: mineMailboxId,
			folderId: otherFolderId,
		});
		expect(result.messages).toHaveLength(0);
	});
});

describe('mail.mailbox.queries.listMessages — sort order', () => {
	/** Three inbox messages an hour apart, oldest ("first") inserted last. */
	async function seedInbox() {
		const t = convexTest(schema, modules);
		let mailboxId!: Id<'mailboxes'>;
		await t.run(async (ctx) => {
			mailboxId = await insertMailbox(ctx, 'test-user');
			const inboxId = await insertFolder(ctx, mailboxId, 'INBOX', 'inbox');
			const base = Date.now() - 10 * 3_600_000;
			await insertMessage(ctx, mailboxId, inboxId, 'third', 3, base + 2 * 3_600_000);
			await insertMessage(ctx, mailboxId, inboxId, 'second', 2, base + 3_600_000);
			await insertMessage(ctx, mailboxId, inboxId, 'first', 1, base);
		});
		return { t, mailboxId };
	}

	it('defaults to newest-first when no order is given', async () => {
		const { t, mailboxId } = await seedInbox();
		const result = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
		});
		expect(result.messages.map((m) => m.subject)).toEqual(['third', 'second', 'first']);
	});

	it('reads the folder oldest-first when asked', async () => {
		const { t, mailboxId } = await seedInbox();
		const result = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
			sortOrder: 'oldest',
		});
		expect(result.messages.map((m) => m.subject)).toEqual(['first', 'second', 'third']);
	});

	it('walks the oldest-first cursor forward without repeating a page', async () => {
		const { t, mailboxId } = await seedInbox();
		const page1 = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
			sortOrder: 'oldest',
			limit: 2,
		});
		expect(page1.messages.map((m) => m.subject)).toEqual(['first', 'second']);
		expect(page1.nextCursor).not.toBeNull();

		const page2 = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
			sortOrder: 'oldest',
			limit: 2,
			cursor: page1.nextCursor ?? undefined,
		});
		expect(page2.messages.map((m) => m.subject)).toEqual(['third']);
	});

	it('applies the same direction to a custom folder addressed by id', async () => {
		const t = convexTest(schema, modules);
		let mailboxId!: Id<'mailboxes'>;
		let customFolderId!: Id<'mailFolders'>;
		await t.run(async (ctx) => {
			mailboxId = await insertMailbox(ctx, 'test-user');
			customFolderId = await insertFolder(ctx, mailboxId, 'Receipts');
			const base = Date.now() - 5 * 3_600_000;
			await insertMessage(ctx, mailboxId, customFolderId, 'newer', 2, base + 3_600_000);
			await insertMessage(ctx, mailboxId, customFolderId, 'older', 1, base);
		});

		const oldest = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderId: customFolderId,
			sortOrder: 'oldest',
		});
		expect(oldest.messages.map((m) => m.subject)).toEqual(['older', 'newer']);
	});
});
