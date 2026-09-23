/**
 * "Team discussion" next to a Postbox email thread.
 *
 * Every `mailThreads` row can grow one internal chat room (`chatRooms.purpose
 * === 'mail_thread_discussion'`, `linkedMailThreadId` = the thread). The room
 * is created on the first post, is never listed in the chat sidebar or the
 * channel browser, and is readable by exactly the people who can read the
 * thread's mailbox: every function here checks `requireMailboxAccess` on the
 * thread's mailbox, and the generic chat room checks in `_helpers.ts` delegate
 * to the same gate for these rooms. Messages and mentions reuse the chat
 * tables and the one insert path (`messageInsert.ts`), so an @mention here
 * lands in the teammate's mention feed like any other.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { isFeatureEnabled } from '../lib/featureFlags';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import { getOrThrow, throwForbidden } from '../_utils/errors';
import { requireMailboxAccess } from '../mail/permissions';
import {
	chatMutation,
	loadProfileSummary,
	MAIL_THREAD_DISCUSSION,
	requireMessageText,
	type ProfileSummary,
} from './_helpers';
import { insertRoomMessage } from './messageInsert';

/** How many recent messages the panel renders. */
const DISCUSSION_PAGE_SIZE = 50;

/** Stored room name. Never shown for these rooms (surfaces use the thread subject). */
const DISCUSSION_ROOM_NAME = 'Thread discussion';

/**
 * The discussion room of a thread, or null before anyone has posted. The index
 * is keyed by thread, and the first row is the oldest, so even a duplicate
 * (which the transactional get-or-create below prevents) would resolve the
 * same room for every reader.
 */
async function findDiscussionRoom(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<Doc<'chatRooms'> | null> {
	const room = await ctx.db
		.query('chatRooms')
		.withIndex('by_linked_mail_thread', (q) => q.eq('linkedMailThreadId', threadId))
		.first();
	return room?.purpose === MAIL_THREAD_DISCUSSION ? room : null;
}

/**
 * Get or create the thread's discussion room. Race-safe: a Convex mutation is
 * one serializable transaction, so two first posts racing on the same thread
 * conflict on the index read and one of them retries — and then finds the room
 * the other created.
 */
async function getOrCreateDiscussionRoom(
	ctx: MutationCtx,
	thread: Doc<'mailThreads'>,
	userId: string
): Promise<Doc<'chatRooms'>> {
	const existing = await findDiscussionRoom(ctx, thread._id);
	if (existing) return existing;
	const now = Date.now();
	const roomId = await ctx.db.insert('chatRooms', {
		// 'channel' + 'private' so any chat path that does not know about
		// `purpose` still fails closed: a private channel without a membership row
		// is invisible to it.
		kind: 'channel',
		purpose: MAIL_THREAD_DISCUSSION,
		linkedMailThreadId: thread._id,
		name: DISCUSSION_ROOM_NAME,
		normalizedName: `mail-thread:${thread._id}`,
		visibility: 'private',
		createdBy: userId,
		createdAt: now,
		updatedAt: now,
		lastMessageAt: now,
		messageCount: 0,
	});
	return await getOrThrow(ctx, roomId, 'Chat room');
}

/**
 * The discussion panel's data for one thread: the room id (null until the
 * first post), the last {@link DISCUSSION_PAGE_SIZE} messages oldest-first,
 * and the total message count (for a "N in discussion" indicator).
 *
 * Soft: returns null — never throws — when chat is off, the thread is gone,
 * or the caller cannot read the thread's mailbox, so the reader simply renders
 * no panel.
 */
export const getForThread = authedQuery({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args, session) => {
		if (!(await isFeatureEnabled(ctx, 'chat'))) return null;
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;
		const access = await requireMailboxAccess(ctx, thread.mailboxId);
		if (!access.ok) return null;

		const room = await findDiscussionRoom(ctx, thread._id);
		if (!room) return { roomId: null, messages: [], count: 0 };

		const recent = await ctx.db
			.query('chatMessages')
			.withIndex('by_room_and_created', (q) => q.eq('roomId', room._id))
			.order('desc')
			.take(DISCUSSION_PAGE_SIZE);

		const profiles = new Map<string, ProfileSummary>();
		const messages = [];
		for (const message of recent.reverse()) {
			if (message.deletedAt) continue;
			let author = profiles.get(message.authorId);
			if (!author) {
				author = await loadProfileSummary(ctx, message.authorId);
				profiles.set(message.authorId, author);
			}
			messages.push({
				_id: message._id,
				authorName: author.name ?? author.email,
				authorImage: author.image,
				body: message.text,
				createdAt: message.createdAt,
				isMine: message.authorId === session.userId,
			});
		}
		return { roomId: room._id, messages, count: room.messageCount };
	},
});

/**
 * Post to a thread's discussion, creating the room on the first message.
 * Requires the `chat:participate` role permission and read access to the
 * thread's mailbox. Returns the room and the new message.
 */
export const post = chatMutation({
	args: { threadId: v.id('mailThreads'), body: v.string() },
	handler: async (ctx, args, session) => {
		requirePermission(hasPermission(session.role, 'chat:participate'), 'Chat is not available');
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const access = await requireMailboxAccess(ctx, thread.mailboxId);
		if (!access.ok) throwForbidden('You do not have access to this thread');
		const text = requireMessageText(args.body);

		const room = await getOrCreateDiscussionRoom(ctx, thread, session.userId);
		const messageId = await insertRoomMessage(ctx, {
			room,
			authorId: session.userId,
			text,
			authorMembership: null,
		});
		return { roomId: room._id, messageId };
	},
});

/**
 * Clear the caller's unread mentions in a thread's discussion (the panel calls
 * this when it opens). Discussion rooms carry no chatRoomMembers row, so the
 * chat `markRead` cannot do it.
 */
export const markRead = chatMutation({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args, session) => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const access = await requireMailboxAccess(ctx, thread.mailboxId);
		if (!access.ok) throwForbidden('You do not have access to this thread');
		const room = await findDiscussionRoom(ctx, thread._id);
		if (!room) return;

		const now = Date.now();
		const unread = await ctx.db
			.query('chatMentions')
			.withIndex('by_mentioned_unread', (q) =>
				q.eq('mentionedMemberId', session.userId).eq('readAt', undefined)
			)
			.collect(); // bounded: caller's unread mentions (small per-user backlog)
		for (const mention of unread) {
			if (mention.roomId !== room._id) continue;
			await ctx.db.patch(mention._id, { readAt: now });
		}
	},
});
