/**
 * Chat room (channel) queries and mutations.
 *
 * Channel = named room with public/private visibility. DMs live in dms.ts
 * even though they share the chatRooms table.
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
import { throwAlreadyExists, throwInvalidInput } from '../_utils/errors';
import {
	CHANNEL_DESC_MAX,
	assertCanAdministerRoom,
	assertChatTargetsAreOrgMembers,
	getRoomOrThrow,
	normalizeChannelName,
	requireChannelName,
} from './_helpers';

/**
 * Create a channel. Public channels are visible to all org members; private
 * channels are invite-only. Creator is added as the channel's first admin.
 */
export const createChannel = authedMutation({
	args: {
		name: v.string(),
		description: v.optional(v.string()),
		visibility: v.union(v.literal('public'), v.literal('private')),
		initialMemberIds: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'chat');
		const { userId, role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'chat:participate'), 'Chat is not available');

		const name = requireChannelName(args.name);
		const normalizedName = normalizeChannelName(name);
		if (args.description && args.description.length > CHANNEL_DESC_MAX) {
			throwInvalidInput(`Description must be ${CHANNEL_DESC_MAX} characters or fewer`);
		}
		// Seed members must be real org members, and the batch is capped.
		await assertChatTargetsAreOrgMembers(ctx, args.initialMemberIds ?? []);

		const existing = await ctx.db
			.query('chatRooms')
			.withIndex('by_kind_and_normalized_name', (q) =>
				q.eq('kind', 'channel').eq('normalizedName', normalizedName),
			)
			.first();
		if (existing) {
			throwAlreadyExists(`A channel named "${name}" already exists`);
		}

		const now = Date.now();
		const roomId = await ctx.db.insert('chatRooms', {
			kind: 'channel',
			name,
			normalizedName,
			description: args.description?.trim() || undefined,
			visibility: args.visibility,
			createdBy: userId,
			createdAt: now,
			updatedAt: now,
			lastMessageAt: now,
			messageCount: 0,
		});

		// Creator joins as admin.
		await ctx.db.insert('chatRoomMembers', {
			roomId,
			memberId: userId,
			role: 'admin',
			joinedAt: now,
			lastReadAt: now,
		});

		// Any additional initial members join as plain members. Deduplicated and
		// the creator's row is skipped.
		const seen = new Set<string>([userId]);
		for (const otherId of args.initialMemberIds ?? []) {
			if (seen.has(otherId)) continue;
			seen.add(otherId);
			await ctx.db.insert('chatRoomMembers', {
				roomId,
				memberId: otherId,
				role: 'member',
				joinedAt: now,
				lastReadAt: now,
			});
		}

		return roomId;
	},
});

/**
 * Rename / re-describe a channel. Per-room admin required (or org-level
 * chat:manage escape hatch).
 */
export const updateChannel = authedMutation({
	args: {
		roomId: v.id('chatRooms'),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
		visibility: v.optional(v.union(v.literal('public'), v.literal('private'))),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'chat');
		const { userId, role } = await getMutationContext(ctx);
		const room = await getRoomOrThrow(ctx, args.roomId);
		if (room.kind !== 'channel') {
			throwInvalidInput('Only channels can be updated this way');
		}
		await assertCanAdministerRoom(ctx, room, userId, role);

		const patch: Partial<{
			name: string;
			normalizedName: string;
			description: string | undefined;
			visibility: 'public' | 'private';
			updatedAt: number;
		}> = { updatedAt: Date.now() };

		if (args.name !== undefined) {
			const name = requireChannelName(args.name);
			const normalizedName = normalizeChannelName(name);
			if (normalizedName !== room.normalizedName) {
				const existing = await ctx.db
					.query('chatRooms')
					.withIndex('by_kind_and_normalized_name', (q) =>
						q.eq('kind', 'channel').eq('normalizedName', normalizedName),
					)
					.first();
				if (existing && existing._id !== room._id) {
					throwAlreadyExists(`A channel named "${name}" already exists`);
				}
			}
			patch.name = name;
			patch.normalizedName = normalizedName;
		}

		if (args.description !== undefined) {
			if (args.description.length > CHANNEL_DESC_MAX) {
				throwInvalidInput(`Description must be ${CHANNEL_DESC_MAX} characters or fewer`);
			}
			patch.description = args.description.trim() || undefined;
		}

		if (args.visibility !== undefined) {
			patch.visibility = args.visibility;
		}

		await ctx.db.patch(args.roomId, patch);
	},
});

/**
 * Archive a channel. Soft-archive via `archivedAt`. Per-room admin required.
 */
export const archiveChannel = authedMutation({
	args: { roomId: v.id('chatRooms') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'chat');
		const { userId, role } = await getMutationContext(ctx);
		const room = await getRoomOrThrow(ctx, args.roomId);
		if (room.kind !== 'channel') {
			throwInvalidInput('Only channels can be archived');
		}
		await assertCanAdministerRoom(ctx, room, userId, role);
		await ctx.db.patch(args.roomId, { archivedAt: Date.now(), updatedAt: Date.now() });
	},
});

/**
 * Unarchive a channel (reverse of archiveChannel).
 */
export const unarchiveChannel = authedMutation({
	args: { roomId: v.id('chatRooms') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'chat');
		const { userId, role } = await getMutationContext(ctx);
		const room = await getRoomOrThrow(ctx, args.roomId);
		if (room.kind !== 'channel') {
			throwInvalidInput('Only channels can be unarchived');
		}
		await assertCanAdministerRoom(ctx, room, userId, role);
		await ctx.db.patch(args.roomId, { archivedAt: undefined, updatedAt: Date.now() });
	},
});

/**
 * List channels visible to the caller:
 *  - all public channels
 *  - private channels the caller is a member of
 *
 * Archived channels are excluded unless `includeArchived` is true.
 */
export const listMyChannels = authedQuery({
	args: { includeArchived: v.optional(v.boolean()) },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'chat');
		const userId = await getUserIdFromSession(ctx);

		// Memberships first — used to filter private channels.
		const memberships = await ctx.db
			.query('chatRoomMembers')
			.withIndex('by_member', (q) => q.eq('memberId', userId))
			.collect(); // bounded: caller's chat rooms (~tens)
		const memberRoomIds = new Set(memberships.map((m) => m.roomId));

		// All channels ordered by recent activity.
		const channels = await ctx.db
			.query('chatRooms')
			.withIndex('by_kind', (q) => q.eq('kind', 'channel'))
			.order('desc')
			.take(500);

		const result = [];
		for (const channel of channels) {
			if (!args.includeArchived && channel.archivedAt) continue;
			if (channel.visibility === 'private' && !memberRoomIds.has(channel._id)) continue;
			result.push({
				...channel,
				isMember: memberRoomIds.has(channel._id),
			});
		}
		// Recent activity first.
		result.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
		return result;
	},
});

/**
 * List PUBLIC channels in the org for a "browse channels" picker (lets the
 * user join channels they're not yet in). Includes membership info.
 */
export const listPublicChannels = authedQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'chat');
		const userId = await getUserIdFromSession(ctx);
		const limit = Math.max(1, Math.min(args.limit ?? 100, 500));

		const channels = await ctx.db
			.query('chatRooms')
			.withIndex('by_visibility', (q) => q.eq('visibility', 'public'))
			.order('desc')
			.take(limit);

		// Filter to channels (a future DM might mistakenly default 'public', but
		// our writers always force DMs to 'private' so this is defensive).
		const onlyChannels = channels.filter((c) => c.kind === 'channel' && !c.archivedAt);

		const memberships = await ctx.db
			.query('chatRoomMembers')
			.withIndex('by_member', (q) => q.eq('memberId', userId))
			.collect(); // bounded: caller's chat rooms (~tens)
		const memberRoomIds = new Set(memberships.map((m) => m.roomId));

		return onlyChannels.map((channel) => ({
			...channel,
			isMember: memberRoomIds.has(channel._id),
		}));
	},
});

/**
 * Get a single room with metadata for the caller (membership flag included).
 * Used by the [roomId].vue page to render the header.
 */
export const getRoom = authedQuery({
	args: { roomId: v.id('chatRooms') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'chat');
		const userId = await getUserIdFromSession(ctx);
		const room = await ctx.db.get(args.roomId);
		if (!room) return null;

		const membership = await ctx.db
			.query('chatRoomMembers')
			.withIndex('by_room_and_member', (q) =>
				q.eq('roomId', room._id).eq('memberId', userId),
			)
			.first();

		// Private rooms: hide entirely if non-member.
		if (room.visibility === 'private' && !membership) {
			return null;
		}

		return {
			...room,
			isMember: !!membership,
			myRole: membership?.role ?? null,
			myLastReadAt: membership?.lastReadAt ?? null,
		};
	},
});
