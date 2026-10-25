/**
 * What the reviewed reads return, not just who may call them: the admin-only
 * activity feed, the room-read policy behind the mention feed and `getRoom`,
 * and the self-scoped chat and dashboard reads. Sessions are real (see
 * queryAuthzFixtures.ts).
 */

import { describe, it, expect } from 'vitest';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	ADMIN,
	EDITOR,
	OWNER,
	as,
	authzHarness,
	room,
	type Harness,
	type Seed,
} from './queryAuthzFixtures';

const forbidden = { data: { category: 'forbidden' } };

describe('analytics.dashboard.getRecentActivity', () => {
	it('narrates audit entries to admins and refuses an editor', async () => {
		const { t, seed } = await authzHarness();
		await t.run(async (ctx) => {
			await ctx.db.insert('auditLogs', {
				userId: OWNER,
				action: 'team_member.invited',
				resource: 'team_member',
				details: { email: 'new.hire@owlat.example' },
				createdAt: Date.now(),
			});
		});

		const feed = await as(t, seed, ADMIN).query(api.analytics.dashboard.getRecentActivity, {});
		expect(feed.map((item) => item.description)).toContain(
			'Invited new.hire@owlat.example to the organization'
		);
		await expect(
			as(t, seed, EDITOR).query(api.analytics.dashboard.getRecentActivity, {})
		).rejects.toMatchObject(forbidden);
	});
});

/** A room with `members`, one message by the owner mentioning the editor, and its mention row. */
async function mentionIn(
	t: Harness,
	name: string,
	visibility: 'public' | 'private',
	members: string[]
): Promise<Id<'chatRooms'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const roomId = await ctx.db.insert('chatRooms', room(name, visibility, now));
		for (const memberId of members) {
			await ctx.db.insert('chatRoomMembers', {
				roomId,
				memberId,
				role: memberId === OWNER ? 'admin' : 'member',
				joinedAt: now,
				lastReadAt: now,
			});
		}
		const messageId = await ctx.db.insert('chatMessages', {
			roomId,
			authorId: OWNER,
			text: `@user-editor see ${name}`,
			createdAt: now,
		});
		await ctx.db.insert('chatMentions', {
			messageId,
			roomId,
			mentionedMemberId: EDITOR,
			mentioningMemberId: OWNER,
			createdAt: now,
		});
		return roomId;
	});
}

async function editorFeed(t: Harness, seed: Seed) {
	const editor = as(t, seed, EDITOR);
	const feed = await editor.query(api.chat.mentions.listMyUnreadMentions, {});
	return {
		rooms: feed.map((mention) => mention.roomName),
		previews: feed.map((mention) => mention.messagePreview),
		visible: await editor.query(api.chat.mentions.countMyVisibleUnreadMentions, {}),
		raw: await editor.query(api.chat.mentions.countMyUnreadMentions, {}),
	};
}

describe('chat mention feed follows the room-read policy', () => {
	it('drops a private channel the member was removed from, keeping public mentions', async () => {
		const { t, seed } = await authzHarness();
		await mentionIn(t, 'lobby', 'public', [OWNER]);
		const secretId = await mentionIn(t, 'secret', 'private', [OWNER, EDITOR]);

		expect(await editorFeed(t, seed)).toMatchObject({
			rooms: expect.arrayContaining(['lobby', 'secret']),
			visible: 2,
			raw: 2,
		});

		await as(t, seed, OWNER).mutation(api.chat.members.removeMember, {
			roomId: secretId,
			memberId: EDITOR,
		});

		const after = await editorFeed(t, seed);
		expect(after.rooms).toEqual(['lobby']);
		expect(after.previews).not.toContain('@user-editor see secret');
		expect(after.visible).toBe(1);
		// The nav badge stays the raw unread-row count; the mention row survives removal.
		expect(after.raw).toBe(2);
	});

	it('drops a private channel the member left', async () => {
		const { t, seed } = await authzHarness();
		await mentionIn(t, 'lobby', 'public', [OWNER]);
		const secretId = await mentionIn(t, 'secret', 'private', [OWNER, EDITOR]);

		await as(t, seed, EDITOR).mutation(api.chat.members.leaveRoom, { roomId: secretId });

		const after = await editorFeed(t, seed);
		expect(after.rooms).toEqual(['lobby']);
		expect(after.visible).toBe(1);
	});

	it('never shows a private channel to an org admin who is not in it', async () => {
		const { t, seed } = await authzHarness();
		const secretId = await mentionIn(t, 'secret', 'private', [OWNER]);
		await t.run(async (ctx) => {
			const mention = await ctx.db.query('chatMentions').first();
			await ctx.db.patch(mention!._id, { mentionedMemberId: ADMIN });
		});

		const admin = as(t, seed, ADMIN);
		expect(await admin.query(api.chat.mentions.listMyUnreadMentions, {})).toEqual([]);
		expect(await admin.query(api.chat.rooms.getRoom, { roomId: secretId })).toBeNull();
	});
});

describe('chat.rooms.getRoom', () => {
	it('answers null for a private room the caller cannot read, as for a missing one', async () => {
		const { t, seed } = await authzHarness();
		const secretId = await mentionIn(t, 'secret', 'private', [OWNER, EDITOR]);

		const editor = as(t, seed, EDITOR);
		expect(await editor.query(api.chat.rooms.getRoom, { roomId: secretId })).toMatchObject({
			name: 'secret',
			isMember: true,
		});
		expect(await editor.query(api.chat.rooms.getRoom, { roomId: seed.publicRoomId })).toMatchObject(
			{ name: 'general', isMember: false, myRole: null }
		);

		await editor.mutation(api.chat.members.leaveRoom, { roomId: secretId });
		expect(await editor.query(api.chat.rooms.getRoom, { roomId: secretId })).toBeNull();
	});
});

describe('self-scoped chat reads', () => {
	it("lists only the caller's DMs and unread rooms", async () => {
		const { t, seed } = await authzHarness();
		const now = Date.now();
		const dmId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('chatRooms', {
				...room(`${OWNER},${ADMIN}`, 'private', now),
				kind: 'dm',
			});
			for (const memberId of [OWNER, ADMIN]) {
				await ctx.db.insert('chatRoomMembers', {
					roomId: id,
					memberId,
					role: 'member',
					joinedAt: now - 1,
					lastReadAt: now - 1,
				});
			}
			await ctx.db.insert('chatMessages', {
				roomId: id,
				authorId: OWNER,
				text: 'just us',
				createdAt: now,
			});
			return id;
		});

		const admin = as(t, seed, ADMIN);
		expect((await admin.query(api.chat.dms.listMyDms, {})).map((dm) => dm._id)).toEqual([dmId]);
		expect(await admin.query(api.chat.messages.myUnreadCounts, {})).toEqual({
			[dmId]: { unreadCount: 1, hasMention: false },
		});

		const editor = as(t, seed, EDITOR);
		expect(await editor.query(api.chat.dms.listMyDms, {})).toEqual([]);
		expect(await editor.query(api.chat.messages.myUnreadCounts, {})).toEqual({});
	});
});

describe('self-scoped dashboard and account reads', () => {
	it("returns the caller's own layout and refuses another member's account ids", async () => {
		const { t, seed } = await authzHarness();
		await t.run(async (ctx) => {
			const updatedAt = Date.now();
			await ctx.db.insert('dashboardLayouts', {
				userId: OWNER,
				rules: [],
				pinnedCards: [{ type: 'recent_contacts', size: 'small' }],
				updatedAt,
			});
			await ctx.db.insert('dashboardLayouts', {
				userId: EDITOR,
				rules: [],
				pinnedCards: [{ type: 'upcoming_campaigns', size: 'small' }],
				updatedAt,
			});
		});

		const editor = as(t, seed, EDITOR);
		const raw = await editor.query(api.analytics.adaptiveDashboard.getRawLayout, {});
		expect(raw?.pinnedCards?.map((card) => card.type)).toEqual(['upcoming_campaigns']);
		const layout = await editor.query(api.analytics.adaptiveDashboard.getLayout, {});
		expect(layout.cards.map((card) => card.type)).toEqual(['upcoming_campaigns']);

		await expect(
			editor.query(api.auth.accountManagement.getPendingDeletionRequest, { userId: OWNER })
		).rejects.toMatchObject(forbidden);
		await expect(
			editor.query(api.auth.onboarding.getWithActualProgress, { userId: OWNER })
		).rejects.toMatchObject(forbidden);
		expect(
			await editor.query(api.auth.onboarding.getWithActualProgress, { userId: EDITOR })
		).toMatchObject({ addedContacts: true });
	});
});

describe('contact export reads', () => {
	it('serve owners and admins, and refuse an editor who can still browse contacts', async () => {
		const { t, seed } = await authzHarness();
		const admin = as(t, seed, ADMIN);
		const rows = await admin.query(api.contacts.organization.listForExportByOrganization, {});
		expect(rows.map((row) => row.email)).toEqual(['reader@example.com']);
		expect(rows[0]).not.toHaveProperty('doiConfirmationToken');
		expect(await admin.query(api.contacts.organization.listAllIdsByOrganization, {})).toEqual({
			ids: [seed.contactId],
			truncated: false,
		});

		const editor = as(t, seed, EDITOR);
		for (const read of [
			editor.query(api.contacts.organization.listForExportByOrganization, {}),
			editor.query(api.contacts.organization.listAllIdsByOrganization, {}),
			editor.query(api.contacts.organization.getPropertyValuesForContacts, {
				contactIds: [seed.contactId],
			}),
		]) {
			await expect(read).rejects.toMatchObject(forbidden);
		}
		const page = await editor.query(api.contacts.contacts.list, {
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(page.page.map((contact) => contact.email)).toEqual(['reader@example.com']);
	});
});
