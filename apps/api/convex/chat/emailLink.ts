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
 *
 * The link bridges two permission domains, so both sides are checked: the
 * chat side by the room gates, the Team Inbox side by the `inbox` feature flag
 * plus the shared-inbox reader gate (`inbox/access.ts`). Linking needs both,
 * and so does reading the panel — a link is never a way to widen who sees the
 * thread.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { openInboundMessageBody } from '../lib/messageBodyInbound';
import { getMutationContext, getUserIdFromSession } from '../lib/sessionOrganization';
import { isFeatureEnabled } from '../lib/featureFlags';
import { getOrThrow, throwForbidden, throwInvalidInput } from '../_utils/errors';
import { isSharedInboxReader } from '../inbox/access';
import {
	chatQuery,
	chatMutation,
	assertCanAdministerRoom,
	assertCanReadRoom,
	getRoomOrThrow,
} from './_helpers';

/**
 * Attach an inbox thread to a channel. Per-room admin required (or org
 * chat:manage), and the caller must be a shared-inbox reader with the `inbox`
 * feature on. Replaces any previous link.
 */
export const linkChannelToInboxThread = chatMutation({
	args: {
		roomId: v.id('chatRooms'),
		inboxThreadId: v.id('conversationThreads'),
	},
	handler: async (ctx, args, session) => {
		const { userId, role } = session;
		const room = await getRoomOrThrow(ctx, args.roomId);
		if (room.kind !== 'channel') {
			throwInvalidInput('Only channels can be linked to email threads');
		}
		await assertCanAdministerRoom(ctx, room, userId, role);
		if (!isSharedInboxReader(session) || !(await isFeatureEnabled(ctx, 'inbox'))) {
			throwForbidden('Linking an email thread requires access to the Team Inbox');
		}

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

/** The panel's preview text: the text part, or the excerpt of one held in
 * storage (a query cannot read the blob), capped for the compact list. */
async function linkedMessagePreviewText(message: Doc<'inboundMessages'>): Promise<string | null> {
	const { text, excerpt } = await openInboundMessageBody(message, null);
	return (text ?? excerpt)?.slice(0, 4000) ?? null;
}

/**
 * Get the inline view of a linked inbox thread: the thread metadata plus a
 * compact list of recent inbound messages for the panel.
 *
 * Caller must be able to read the chat room. Returns null if the room has no
 * linked thread, if the `inbox` feature is off, or if the caller is not a
 * shared-inbox reader. Checked on every read rather than at link time alone,
 * so a link carries no access of its own and a link made before this check
 * existed shows nothing to a channel reader outside the Team Inbox.
 */
export const getLinkedThreadView = chatQuery({
	args: { roomId: v.id('chatRooms') },
	handler: async (ctx, args, session) => {
		const room = await getRoomOrThrow(ctx, args.roomId);
		await assertCanReadRoom(ctx, room, session.userId);

		if (!room.linkedInboxThreadId) return null;
		if (!isSharedInboxReader(session)) return null;
		if (!(await isFeatureEnabled(ctx, 'inbox'))) return null;

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
			recentMessages: await Promise.all(
				recentInbound.map(async (m) => ({
					_id: m._id,
					from: m.from,
					to: m.to,
					subject: m.subject,
					textBody: await linkedMessagePreviewText(m),
					receivedAt: m.receivedAt,
					processingStatus: m.processingStatus,
				}))
			),
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
