/**
 * Coverage for mail.mailbox.newestUnreadInbox — the bounded peek window behind
 * the desktop tray/menubar peek and category-aware toast decisions. The
 * smart-inbox `category` object lives on the THREAD (mailThreads.category), not
 * on the message, so this asserts the query sources the label from the thread —
 * the wiring the pure notificationRules unit tests can't reach.
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

async function seedInboxMessage(
	t: ReturnType<typeof convexTest>,
	opts: {
		mailboxId: Id<'mailboxes'>;
		folderId: Id<'mailFolders'>;
		subject: string;
		category?: 'person' | 'newsletter' | 'notification' | 'receipt' | 'other';
	}
): Promise<void> {
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
			category: opts.category
				? { label: opts.category, source: 'heuristic', classifiedAt: now }
				: undefined,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('mailMessages', {
			mailboxId: opts.mailboxId,
			folderId: opts.folderId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: `<${opts.subject}@example.com>`,
			threadId,
			fromName: 'Alice',
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
	});
}

describe('mail.mailbox.newestUnreadInbox', () => {
	it("populates each peek message's category from its thread", async () => {
		const t = convexTest(schema, modules);
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
				totalCount: 2,
				unseenCount: 2,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		});

		await seedInboxMessage(t, {
			mailboxId,
			folderId,
			subject: 'From a person',
			category: 'person',
		});
		await seedInboxMessage(t, {
			mailboxId,
			folderId,
			subject: 'Uncategorized',
		});

		const peek = await t.query(api.mail.mailbox.newestUnreadInbox, {});
		expect(peek.total).toBe(2);
		const bySubject = Object.fromEntries(
			peek.messages.map((m) => [m.subject, m.category])
		);
		// Category is sourced from the thread, not the (category-less) message.
		expect(bySubject['From a person']).toBe('person');
		// Thread with no category falls open to undefined (the fail-open path).
		expect(bySubject['Uncategorized']).toBeUndefined();
	});
});
