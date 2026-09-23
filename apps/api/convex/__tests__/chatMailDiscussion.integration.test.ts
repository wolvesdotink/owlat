/**
 * The per-thread "Team discussion" (chat/mailDiscussion.ts) and the narrow
 * branches it adds to the chat room checks.
 *
 * The audience rule under test: a discussion is visible to exactly the people
 * who can read the thread's mailbox — the mailbox's own user, a mailboxMembers
 * row, or an org owner/admin — and to nobody else, whatever their chat role.
 * The generic chat paths (listMessages, sendMessage, addMember, listMyChannels,
 * getRoom) must neither leak the room nor let anyone around that rule.
 */

import type { TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type schema from '../schema';
import type { Id } from '../_generated/dataModel';
import type * as SessionOrganization from '../lib/sessionOrganization';
import { api } from '../_generated/api';
import { enableFeatures } from './factories';
import { newBetterAuthHarness } from './testModules';

type Role = 'owner' | 'admin' | 'editor';

// One hoisted session drives every floor the discussion touches: the
// authedQuery/authedMutation floors, the mailbox gate (getBetterAuthSessionWithRole)
// and the older chat handlers that still resolve their own session.
const sessionMock = vi.hoisted(() => ({ userId: 'user-owner', role: 'editor' as Role }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
	const session = () => ({
		userId: sessionMock.userId,
		role: sessionMock.role,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session()),
		getUserIdFromSession: vi.fn(async () => sessionMock.userId),
		getBetterAuthSessionWithRole: vi.fn(async () => session()),
		requireOrgPermission: vi.fn(async (_ctx: unknown, permission: string, message?: string) => {
			// An assertion function must be called through an explicitly typed name.
			const mod: typeof SessionOrganization = actual;
			mod.requirePermission(
				mod.hasPermission(sessionMock.role, permission as Parameters<typeof mod.hasPermission>[1]),
				message
			);
			return session();
		}),
	};
});

function setUser(userId: string, role: Role = 'editor') {
	sessionMock.userId = userId;
	sessionMock.role = role;
}

// user-owner owns the shared mailbox, user-member is on it, user-outsider is an
// org editor with no mailbox access, user-elsewhere belongs to another mailbox.
const PEOPLE = ['user-owner', 'user-member', 'user-outsider', 'user-elsewhere'];

async function seed(t: TestConvex<typeof schema>) {
	await enableFeatures(t, ['chat', 'mail.external']);
	return await t.run(async (ctx) => {
		const now = Date.now();
		for (const id of PEOPLE) {
			await ctx.db.insert('userProfiles', {
				authUserId: id,
				email: `${id}@example.com`,
				name: id,
				createdAt: now,
				updatedAt: now,
			});
		}
		const mailbox = (userId: string, address: string) =>
			ctx.db.insert('mailboxes', {
				userId,
				organizationId: 'org-1',
				address,
				domain: 'owlat.test',
				scope: 'shared',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
		const mailboxId = await mailbox('user-owner', 'support@owlat.test');
		const otherMailboxId = await mailbox('user-elsewhere', 'sales@owlat.test');
		for (const [mbId, authUserId, role] of [
			[mailboxId, 'user-owner', 'owner'],
			[mailboxId, 'user-member', 'member'],
			[otherMailboxId, 'user-elsewhere', 'owner'],
		] as const) {
			await ctx.db.insert('mailboxMembers', {
				mailboxId: mbId,
				authUserId,
				role,
				addedBy: 'user-owner',
				createdAt: now,
			});
		}
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'spf still failing',
			participants: ['ops@customer.example'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'We published the record',
			latestFromAddress: 'ops@customer.example',
			latestSubject: 'SPF still failing',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		return { mailboxId, threadId };
	});
}

async function postAs(
	t: TestConvex<typeof schema>,
	userId: string,
	threadId: Id<'mailThreads'>,
	body: string
) {
	setUser(userId);
	return await t.mutation(api.chat.mailDiscussion.post, { threadId, body });
}

beforeEach(() => setUser('user-owner'));

describe('chat.mailDiscussion — mailbox readers', () => {
	it('lets a mailbox member post and read, creating one room on the first post', async () => {
		const t = newBetterAuthHarness();
		const { threadId } = await seed(t);

		setUser('user-member');
		expect(await t.query(api.chat.mailDiscussion.getForThread, { threadId })).toEqual({
			roomId: null,
			messages: [],
			count: 0,
		});

		const first = await postAs(t, 'user-member', threadId, 'Their record has two v=spf1 strings.');
		const second = await postAs(t, 'user-owner', threadId, 'On it.');
		expect(second.roomId).toBe(first.roomId);

		const rooms = await t.run((ctx) =>
			ctx.db
				.query('chatRooms')
				.withIndex('by_linked_mail_thread', (q) => q.eq('linkedMailThreadId', threadId))
				.collect()
		);
		expect(rooms).toHaveLength(1);
		expect(rooms[0]).toMatchObject({ purpose: 'mail_thread_discussion', visibility: 'private' });
		// The audience is the mailbox, not a chat roster.
		const memberships = await t.run((ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room', (q) => q.eq('roomId', first.roomId))
				.collect()
		);
		expect(memberships).toHaveLength(0);

		setUser('user-member');
		const view = await t.query(api.chat.mailDiscussion.getForThread, { threadId });
		expect(view?.count).toBe(2);
		expect(view?.messages.map((m) => [m.body, m.authorName, m.isMine])).toEqual([
			['Their record has two v=spf1 strings.', 'user-member', true],
			['On it.', 'user-owner', false],
		]);

		// The generic chat read path agrees with the mailbox gate.
		const listed = await t.query(api.chat.messages.listMessages, { roomId: first.roomId });
		expect(listed.messages).toHaveLength(2);
	});

	it('lets an org admin with no mailbox row read, like the mailbox gate does', async () => {
		const t = newBetterAuthHarness();
		const { threadId } = await seed(t);
		await postAs(t, 'user-member', threadId, 'hello');
		setUser('user-admin', 'admin');
		const view = await t.query(api.chat.mailDiscussion.getForThread, { threadId });
		expect(view?.messages).toHaveLength(1);
	});
});

describe('chat.mailDiscussion — people who cannot read the mailbox', () => {
	it('hides the discussion from an org editor without mailbox access', async () => {
		const t = newBetterAuthHarness();
		const { threadId } = await seed(t);
		const { roomId } = await postAs(t, 'user-member', threadId, 'internal note');

		setUser('user-outsider');
		expect(await t.query(api.chat.mailDiscussion.getForThread, { threadId })).toBeNull();
		await expect(
			t.mutation(api.chat.mailDiscussion.post, { threadId, body: 'let me in' })
		).rejects.toThrow(/access/i);
		await expect(t.query(api.chat.messages.listMessages, { roomId })).rejects.toThrow(/access/i);
		expect(await t.query(api.chat.rooms.getRoom, { roomId })).toBeNull();
	});

	it('refuses a member of a different mailbox', async () => {
		const t = newBetterAuthHarness();
		const { threadId } = await seed(t);
		await postAs(t, 'user-member', threadId, 'internal note');

		setUser('user-elsewhere');
		expect(await t.query(api.chat.mailDiscussion.getForThread, { threadId })).toBeNull();
		await expect(
			t.mutation(api.chat.mailDiscussion.post, { threadId, body: 'hi' })
		).rejects.toThrow(/access/i);
	});

	it('keeps the generic chat write and admin paths closed on discussion rooms', async () => {
		const t = newBetterAuthHarness();
		const { threadId } = await seed(t);
		const { roomId, messageId } = await postAs(t, 'user-member', threadId, 'internal note');

		// Even a mailbox reader cannot route around the thread through sendMessage.
		setUser('user-member');
		await expect(
			t.mutation(api.chat.messages.sendMessage, { roomId, text: 'side door' })
		).rejects.toThrow(/email thread/i);

		// chat:manage is not mailbox access: an org owner cannot add the outsider,
		// nor delete someone else's message.
		setUser('user-admin', 'owner');
		await expect(
			t.mutation(api.chat.members.addMember, { roomId, memberId: 'user-outsider' })
		).rejects.toThrow(/mailbox access/i);
		await expect(t.mutation(api.chat.messages.deleteMessage, { messageId })).rejects.toThrow(
			/author/i
		);
	});
});

describe('chat.mailDiscussion — chat surfaces', () => {
	it('never lists a discussion room in the sidebar or the channel browser', async () => {
		const t = newBetterAuthHarness();
		const { threadId } = await seed(t);
		setUser('user-owner', 'owner');
		const channelId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'ops',
			visibility: 'public',
		});
		const { roomId } = await postAs(t, 'user-owner', threadId, 'note');

		for (const role of ['owner', 'editor'] as const) {
			setUser('user-owner', role);
			const mine = await t.query(api.chat.rooms.listMyChannels, { includeArchived: true });
			expect(mine.map((c) => c._id)).toEqual([channelId]);
			const browse = await t.query(api.chat.rooms.listPublicChannels, {});
			expect(browse.map((c) => c._id)).not.toContain(roomId);
		}
	});

	it('returns null when chat is off and refuses to post', async () => {
		const t = newBetterAuthHarness();
		const { threadId } = await seed(t);
		await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(settings!._id, {
				featureFlags: { ...settings!.featureFlags, chat: false },
			});
		});
		setUser('user-member');
		expect(await t.query(api.chat.mailDiscussion.getForThread, { threadId })).toBeNull();
		await expect(
			t.mutation(api.chat.mailDiscussion.post, { threadId, body: 'hi' })
		).rejects.toThrow(/disabled/i);
	});
});

describe('chat.mailDiscussion — mentions', () => {
	it('notifies mailbox readers only and points the feed at the thread', async () => {
		const t = newBetterAuthHarness();
		const { threadId, mailboxId } = await seed(t);
		const { roomId } = await postAs(
			t,
			'user-member',
			threadId,
			'@user-owner can you send the merged record? cc @user-outsider'
		);

		const mentions = await t.run((ctx) =>
			ctx.db
				.query('chatMentions')
				.withIndex('by_room', (q) => q.eq('roomId', roomId))
				.collect()
		);
		expect(mentions.map((m) => m.mentionedMemberId)).toEqual(['user-owner']);

		setUser('user-owner');
		const feed = await t.query(api.chat.mentions.listMyUnreadMentions, {});
		expect(feed).toHaveLength(1);
		expect(feed[0]).toMatchObject({
			roomId,
			roomName: 'SPF still failing',
			mailThread: { threadId, mailboxId },
		});

		await t.mutation(api.chat.mailDiscussion.markRead, { threadId });
		expect(await t.query(api.chat.mentions.countMyUnreadMentions, {})).toBe(0);
	});

	it('drops a discussion mention from the feed once mailbox access is gone', async () => {
		const t = newBetterAuthHarness();
		const { threadId, mailboxId } = await seed(t);
		await postAs(t, 'user-owner', threadId, '@user-member please look');

		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('mailboxMembers')
				.withIndex('by_mailbox_user', (q) =>
					q.eq('mailboxId', mailboxId).eq('authUserId', 'user-member')
				)
				.unique();
			await ctx.db.delete(row!._id);
		});

		setUser('user-member');
		expect(await t.query(api.chat.mentions.listMyUnreadMentions, {})).toEqual([]);
	});
});
