/**
 * Team (shared) inbox read state is a single shared truth.
 *
 * When one member marks a shared-inbox message read, every other member sees it
 * read on the next reactive tick — the honest model for a support queue (LOCKED
 * decision 7 of the 2026-07-10 experience plan). Covers `mailbox.unreadByMailbox`
 * and `mailbox.inboxUnreadCount` across two members and the shared
 * `messageActions.setFlags` mark-read path.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox } from './helpers';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor' | null,
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => {
			if (sessionMock.role === null) throw new Error('Not authenticated');
			return { userId: sessionMock.userId, role: sessionMock.role };
		}),
		getMutationContext: vi.fn(async () => {
			if (sessionMock.role === null) throw new Error('Not authenticated');
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => {
			if (sessionMock.role === null) return null;
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
	};
});

function setSession(userId: string, role: 'owner' | 'admin' | 'editor' | null, orgId = 'org-1') {
	sessionMock.userId = userId;
	sessionMock.role = role;
	sessionMock.orgId = orgId;
}

/**
 * A shared inbox owned by user-A (owner membership) with user-B as a plain
 * member, an inbox folder holding one unread message. Returns the ids.
 */
async function seedSharedInboxWithUnread(t: TestConvex<typeof schema>): Promise<{
	mailboxId: Id<'mailboxes'>;
	messageId: Id<'mailMessages'>;
}> {
	const mailboxId = await seedMailbox(t, {
		userId: 'user-A',
		scope: 'shared',
		address: 'sales@hinterland.camp',
	});
	const { messageId } = await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('mailboxMembers', {
			mailboxId,
			authUserId: 'user-A',
			role: 'owner',
			addedBy: 'user-A',
			createdAt: now,
		});
		await ctx.db.insert('mailboxMembers', {
			mailboxId,
			authUserId: 'user-B',
			role: 'member',
			addedBy: 'user-A',
			createdAt: now,
		});
		const folderId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 2,
			highestModseq: 1,
			totalCount: 1,
			unseenCount: 1,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'help',
			participants: ['customer@acme.com'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'Can you help?',
			latestFromAddress: 'customer@acme.com',
			latestSubject: 'help',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const id = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<c1@acme.com>',
			threadId,
			fromAddress: 'customer@acme.com',
			toAddresses: ['sales@hinterland.camp'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'help',
			normalizedSubject: 'help',
			snippet: 'Can you help?',
			rawStorageId,
			rawSize: 3,
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
		return { messageId: id };
	});
	return { mailboxId, messageId };
}

function unreadFor(
	rows: Array<{ mailboxId: Id<'mailboxes'>; unread: number }>,
	mailboxId: Id<'mailboxes'>
): number {
	return rows.find((r) => r.mailboxId === mailboxId)?.unread ?? 0;
}

describe('shared inbox unread is one shared truth across members', () => {
	it('both members see the same unread count, and a mark-read by one clears it for the other', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId } = await seedSharedInboxWithUnread(t);

		// Both members start seeing the one unread message.
		setSession('user-A', 'editor');
		expect(await t.query(api.mail.mailbox.inboxUnreadCount, {})).toBe(1);
		setSession('user-B', 'editor');
		expect(await t.query(api.mail.mailbox.inboxUnreadCount, {})).toBe(1);
		expect(unreadFor(await t.query(api.mail.mailbox.unreadByMailbox, {}), mailboxId)).toBe(1);

		// user-A reads it via the shared, access-gated mark-read path.
		setSession('user-A', 'editor');
		await t.mutation(api.mail.messageActions.setFlags, {
			messageIds: [messageId],
			seen: true,
		});

		// user-B now sees it read too — the read state is shared, not per-user.
		setSession('user-B', 'editor');
		expect(await t.query(api.mail.mailbox.inboxUnreadCount, {})).toBe(0);
		expect(unreadFor(await t.query(api.mail.mailbox.unreadByMailbox, {}), mailboxId)).toBe(0);
	});

	it('unreadByMailbox returns nothing for a user with no accessible mailbox', async () => {
		const t = convexTest(schema, modules);
		await seedSharedInboxWithUnread(t);
		setSession('stranger', 'editor');
		expect(await t.query(api.mail.mailbox.unreadByMailbox, {})).toEqual([]);
	});
});
