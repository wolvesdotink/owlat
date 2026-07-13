/**
 * Link a chat channel to an inbox conversation thread ("inline view"
 * semantics).
 *
 * - A channel may carry `linkedInboxThreadId` pointing to a row in the
 *   `conversationThreads` table from the inbox feature.
 * - Channel members see a pinned read-only panel inside the channel with the
 *   linked email thread; replies to the customer still flow through the
 *   inbox UI / approval pipeline.
 * - DMs cannot be linked (we keep the model simple — 1:1 inline-view).
 */

import { v } from 'convex/values';
import { inboundMessageBody } from '../lib/messageBody';
import { getMutationContext, getUserIdFromSession } from '../lib/sessionOrganization';
import { getOrThrow, throwInvalidInput } from '../_utils/errors';
import {
	chatQuery,
	chatMutation,
	assertCanAdministerRoom,
	assertCanReadRoom,
	getRoomOrThrow,
} from './_helpers';

/**
 * Attach an inbox thread to a channel. Per-room admin required (or org
 * chat:manage). Replaces any previous link.
 */
export const linkChannelToInboxThread = chatMutation({
	args: {
		roomId: v.id('chatRooms'),
		inboxThreadId: v.id('conversationThreads'),
	},
	handler: async (ctx, args) => {
		const { userId, role } = await getMutationContext(ctx);
		const room = await getRoomOrThrow(ctx, args.roomId);
		if (room.kind !== 'channel') {
			throwInvalidInput('Only channels can be linked to email threads');
		}
		await assertCanAdministerRoom(ctx, room, userId, role);

		const inboxThread = await getOrThrow(ctx, args.inboxThreadId, 'Inbox thread');
		// Internal pseudo-threads from the old chat scaffold are not linkable.
		if (
			inboxThread.contactIdentifier === 'internal-chat' ||
			inboxThread.contactIdentifier === 'channel'
		) {
			throwInvalidInput('That thread is not an inbox conversation');
		}

		await ctx.db.patch(args.roomId, {
			linkedInboxThreadId: args.inboxThreadId,
			updatedAt: Date.now(),
		});
		// Truthy success value so the client can distinguish success from the
		// useBackendOperation failure sentinel (undefined).
		return { success: true as const };
	},
});

/**
 * Detach the inbox thread from a channel.
 */
export const unlinkChannel = chatMutation({
	args: { roomId: v.id('chatRooms') },
	handler: async (ctx, args) => {
		const { userId, role } = await getMutationContext(ctx);
		const room = await getRoomOrThrow(ctx, args.roomId);
		await assertCanAdministerRoom(ctx, room, userId, role);
		if (!room.linkedInboxThreadId) return { success: true as const };

		await ctx.db.patch(args.roomId, {
			linkedInboxThreadId: undefined,
			updatedAt: Date.now(),
		});
		return { success: true as const };
	},
});

/**
 * Get the inline view of a linked inbox thread: the thread metadata plus a
 * compact list of recent inbound messages for the panel.
 *
 * Caller must be able to read the chat room. Returns null if the room has no
 * linked thread.
 */
export const getLinkedThreadView = chatQuery({
	args: { roomId: v.id('chatRooms') },
	handler: async (ctx, args) => {
		const userId = await getUserIdFromSession(ctx);
		const room = await getRoomOrThrow(ctx, args.roomId);
		await assertCanReadRoom(ctx, room, userId);

		if (!room.linkedInboxThreadId) return null;

		const thread = await ctx.db.get(room.linkedInboxThreadId);
		if (!thread) return null;

		const recentInbound = await ctx.db
			.query('inboundMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', thread._id))
			.order('desc')
			.take(20);

		// Reverse so the UI gets oldest→newest for display.
		recentInbound.reverse();

		return {
			thread: {
				_id: thread._id,
				subject: thread.subject,
				contactIdentifier: thread.contactIdentifier,
				contactId: thread.contactId,
				status: thread.status,
				messageCount: thread.messageCount,
				lastMessageAt: thread.lastMessageAt,
				assignedTo: thread.assignedTo,
			},
			recentMessages: recentInbound.map((m) => ({
				_id: m._id,
				from: m.from,
				to: m.to,
				subject: m.subject,
				textBody: inboundMessageBody(m).text?.slice(0, 4000) ?? null,
				receivedAt: m.receivedAt,
				processingStatus: m.processingStatus,
			})),
		};
	},
});

/**
 * For an inbox thread, find which (if any) chat channels reference it.
 * Used by the inbox thread detail page to render a "Discussed in #channel"
 * indicator + jump link.
 */
export const findChannelsForInboxThread = chatQuery({
	args: { inboxThreadId: v.id('conversationThreads') },
	handler: async (ctx, args) => {
		const userId = await getUserIdFromSession(ctx);

		const channels = await ctx.db
			.query('chatRooms')
			.withIndex('by_linked_inbox_thread', (q) => q.eq('linkedInboxThreadId', args.inboxThreadId))
			.take(50);

		// Filter to channels the caller can see (public + member of private).
		const memberships = await ctx.db
			.query('chatRoomMembers')
			.withIndex('by_member', (q) => q.eq('memberId', userId))
			.collect(); // bounded: caller's chat rooms (~tens)
		const memberRoomIds = new Set(memberships.map((m) => m.roomId.toString()));

		return channels
			.filter((c) => c.kind === 'channel' && !c.archivedAt)
			.filter((c) => c.visibility === 'public' || memberRoomIds.has(c._id.toString()))
			.map((c) => ({
				_id: c._id,
				name: c.name,
				visibility: c.visibility,
				isMember: memberRoomIds.has(c._id.toString()),
			}));
	},
});
