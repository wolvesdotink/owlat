/**
 * Per-room membership operations: join/leave/invite/remove/role.
 */

import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import {
	getMutationContext,
	getUserIdFromSession,
	requirePermission,
	hasPermission,
} from '../lib/sessionOrganization';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { throwForbidden, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import {
	assertCanAdministerRoom,
	assertCanReadRoom,
	assertChatTargetsAreOrgMembers,
	getMembership,
	getRoomOrThrow,
	loadProfileSummary,
} from './_helpers';

/**
 * Join a public channel. Idempotent: a no-op if the caller is already a
 * member.
 */
export const joinChannel = authedMutation({
	args: { roomId: v.id('chatRooms') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'chat');
		const { userId, role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'chat:participate'), 'Chat is not available');

		const room = await getRoomOrThrow(ctx, args.roomId);
		if (room.kind !== 'channel') {
			throwInvalidInput('Only channels can be joined directly');
		}
		if (room.archivedAt) {
			throwInvalidState('Channel is archived');
		}
		if (room.visibility === 'private') {
			throwForbidden('Private channels require an invite');
		}

		const existing = await getMembership(ctx, args.roomId, userId);
		if (existing) return existing._id;

		const now = Date.now();
		return await ctx.db.insert('chatRoomMembers', {
			roomId: args.roomId,
			memberId: userId,
			role: 'member',
			joinedAt: now,
			lastReadAt: now,
		});
	},
});

/**
 * Leave a room. For DMs you can't leave — the room is shared and a leave
 * would silently delete history for the other side; archive instead.
 */
// authz: self — a member removes only their own room membership.
export const leaveRoom = authedMutation({
	args: { roomId: v.id('chatRooms') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'chat');
		const { userId } = await getMutationContext(ctx);
		const room = await getRoomOrThrow(ctx, args.roomId);
		if (room.kind === 'dm') {
			throwInvalidInput('You cannot leave a direct message');
		}
		const membership = await getMembership(ctx, args.roomId, userId);
		if (!membership) return;

		// Prevent the last admin from leaving a channel without handing over.
		if (membership.role === 'admin') {
			const allMembers = await ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room', (q) => q.eq('roomId', args.roomId))
				.collect(); // bounded: members of one chat room (~tens to low hundreds)
			const otherAdmins = allMembers.filter(
				(m) => m._id !== membership._id && m.role === 'admin',
			);
			if (otherAdmins.length === 0 && allMembers.length > 1) {
				throwInvalidState(
					'You are the last admin. Promote someone else first or archive the channel.',
				);
			}
		}

		await ctx.db.delete(membership._id);
	},
});

/**
 * Add another org user to a channel. Per-room admin (or org chat:manage)
 * required. Idempotent — no-op if already a member.
 */
export const addMember = authedMutation({
	args: {
		roomId: v.id('chatRooms'),
		memberId: v.string(),
		role: v.optional(v.union(v.literal('admin'), v.literal('member'))),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'chat');
		const { userId, role } = await getMutationContext(ctx);
		const room = await getRoomOrThrow(ctx, args.roomId);
		if (room.kind === 'dm') {
			throwInvalidInput('Add members to a DM by starting a new group DM');
		}
		await assertCanAdministerRoom(ctx, room, userId, role);

		// The added member must be a real org member, not an arbitrary id.
		await assertChatTargetsAreOrgMembers(ctx, [args.memberId]);

		const existing = await getMembership(ctx, args.roomId, args.memberId);
		if (existing) return existing._id;

		const now = Date.now();
		return await ctx.db.insert('chatRoomMembers', {
			roomId: args.roomId,
			memberId: args.memberId,
			role: args.role ?? 'member',
			joinedAt: now,
			lastReadAt: now,
		});
	},
});

/**
 * Remove a user from a channel. Per-room admin (or chat:manage) required.
 */
export const removeMember = authedMutation({
	args: { roomId: v.id('chatRooms'), memberId: v.string() },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'chat');
		const { userId, role } = await getMutationContext(ctx);
		const room = await getRoomOrThrow(ctx, args.roomId);
		if (room.kind === 'dm') {
			throwInvalidInput('Cannot remove a DM participant');
		}
		await assertCanAdministerRoom(ctx, room, userId, role);

		const membership = await getMembership(ctx, args.roomId, args.memberId);
		if (!membership) return;

		// Don't strand the channel without admins.
		if (membership.role === 'admin') {
			const allMembers = await ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room', (q) => q.eq('roomId', args.roomId))
				.collect(); // bounded: members of one chat room (~tens to low hundreds)
			const otherAdmins = allMembers.filter(
				(m) => m._id !== membership._id && m.role === 'admin',
			);
			if (otherAdmins.length === 0) {
				throwInvalidState('Promote another admin before removing the last one');
			}
		}

		await ctx.db.delete(membership._id);
	},
});

/**
 * Change a member's per-room role (admin <-> member). Per-room admin (or
 * chat:manage) required.
 */
export const setMemberRole = authedMutation({
	args: {
		roomId: v.id('chatRooms'),
		memberId: v.string(),
		role: v.union(v.literal('admin'), v.literal('member')),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'chat');
		const { userId, role } = await getMutationContext(ctx);
		const room = await getRoomOrThrow(ctx, args.roomId);
		if (room.kind === 'dm') {
			throwInvalidInput('DM roles are fixed');
		}
		await assertCanAdministerRoom(ctx, room, userId, role);

		const membership = await getMembership(ctx, args.roomId, args.memberId);
		if (!membership) {
			throwInvalidInput('User is not a member of this room');
		}

		// Prevent demoting the last admin.
		if (membership.role === 'admin' && args.role === 'member') {
			const allMembers = await ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room', (q) => q.eq('roomId', args.roomId))
				.collect(); // bounded: members of one chat room (~tens to low hundreds)
			const otherAdmins = allMembers.filter(
				(m) => m._id !== membership._id && m.role === 'admin',
			);
			if (otherAdmins.length === 0) {
				throwInvalidState('Promote another admin before demoting the last one');
			}
		}

		await ctx.db.patch(membership._id, { role: args.role });
	},
});

/**
 * List members of a room. Caller must be able to read the room.
 *
 * Joins user profiles by authUserId so the UI can render names/avatars.
 */
export const listRoomMembers = authedQuery({
	args: { roomId: v.id('chatRooms') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'chat');
		const userId = await getUserIdFromSession(ctx);
		const room = await getRoomOrThrow(ctx, args.roomId);
		await assertCanReadRoom(ctx, room, userId);

		const memberships = await ctx.db
			.query('chatRoomMembers')
			.withIndex('by_room', (q) => q.eq('roomId', args.roomId))
			.collect(); // bounded: members of one chat room (~tens to low hundreds)

		const result = [];
		for (const m of memberships) {
			const profile = await loadProfileSummary(ctx, m.memberId);
			result.push({
				_id: m._id,
				memberId: m.memberId,
				role: m.role,
				joinedAt: m.joinedAt,
				lastReadAt: m.lastReadAt,
				...profile,
			});
		}
		return result;
	},
});
