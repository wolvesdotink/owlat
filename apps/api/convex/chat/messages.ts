/**
 * Chat message read/write operations: listMessages (with profile join),
 * sendMessage, editMessage, deleteMessage, markRead.
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import {
	getMutationContext,
	getUserIdFromSession,
	requireOrgPermission,
	hasPermission,
} from '../lib/sessionOrganization';
import { isFeatureEnabled } from '../lib/featureFlags';
import { throwForbidden, throwInvalidInput, throwNotFound } from '../_utils/errors';
import {
	chatQuery,
	chatMutation,
	assertCanReadRoom,
	assertCanWriteRoom,
	getMembership,
	getRoomOrThrow,
	loadProfileSummary,
	parseMentionHandles,
	requireMessageText,
	isAssistantInvoked,
	ASSISTANT_AUTHOR_ID,
	type ProfileSummary,
} from './_helpers';
import { resolveMentionsToMemberIds } from './mentions';
import {
	assistantToolCallValidator,
	assistantMessageStatusValidator,
	tokenUsageValidator,
} from '../lib/convexValidators';

/** How many recent room messages to feed the @assistant as context. */
const CHAT_CONTEXT_LIMIT = 30;

/**
 * Paginated message list for a single room, newest first. The frontend reverses
 * for display so the newest message is at the bottom.
 *
 * Each message is enriched with author profile info (name/image) so the UI
 * doesn't need a second query per row.
 */
export const listMessages = chatQuery({
	args: {
		roomId: v.id('chatRooms'),
		limit: v.optional(v.number()),
		// Cursor = createdAt of the oldest message currently rendered; pass to
		// page back into older history.
		beforeCreatedAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const userId = await getUserIdFromSession(ctx);
		const room = await getRoomOrThrow(ctx, args.roomId);
		await assertCanReadRoom(ctx, room, userId);

		const limit = Math.max(1, Math.min(args.limit ?? 50, 500));

		const baseQuery = ctx.db
			.query('chatMessages')
			.withIndex('by_room_and_created', (q) =>
				args.beforeCreatedAt !== undefined
					? q.eq('roomId', args.roomId).lt('createdAt', args.beforeCreatedAt)
					: q.eq('roomId', args.roomId),
			)
			.order('desc');

		const page = await baseQuery.take(limit + 1);
		const hasMore = page.length > limit;
		const messages = hasMore ? page.slice(0, limit) : page;

		// Profile join — small loop, room rosters are bounded. The reserved
		// assistant author has no userProfiles row, so it's labelled directly and
		// flagged `isAssistant` for the renderer (streaming + tool-call cards).
		const profileCache = new Map<string, ProfileSummary>();
		const enriched = [];
		for (const message of messages) {
			const isAssistant = message.authorId === ASSISTANT_AUTHOR_ID;
			let author: ProfileSummary;
			if (isAssistant) {
				author = { name: 'Assistant', email: null, image: null };
			} else {
				let cached = profileCache.get(message.authorId);
				if (!cached) {
					cached = await loadProfileSummary(ctx, message.authorId);
					profileCache.set(message.authorId, cached);
				}
				author = cached;
			}
			enriched.push({ ...message, author, isAssistant });
		}

		// Return ascending so the UI can append in order. The "before" cursor
		// pagination semantics are preserved via the `nextCursor` value.
		enriched.reverse();
		return {
			messages: enriched,
			hasMore,
			nextCursor: hasMore ? enriched[0]?.createdAt ?? null : null,
		};
	},
});

/**
 * Send a chat message into a room. Caller must be a member.
 *
 * Side effects:
 *  - Inserts a chatMessages row
 *  - Inserts a chatMentions row per resolved @-mention (best-effort: handles
 *    that can't be resolved to a known userProfile are silently dropped)
 *  - Bumps chatRooms.lastMessageAt / messageCount
 *  - Updates the sender's chatRoomMembers.lastReadAt
 */
export const sendMessage = chatMutation({
	args: {
		roomId: v.id('chatRooms'),
		text: v.string(),
		attachmentIds: v.optional(v.array(v.id('mediaAssets'))),
	},
	handler: async (ctx, args) => {
		const { userId } = await requireOrgPermission(ctx, 'chat:participate', 'Chat is not available');

		const room = await getRoomOrThrow(ctx, args.roomId);
		if (room.archivedAt) {
			throwInvalidInput('Cannot post to an archived room');
		}
		const membership = await assertCanWriteRoom(ctx, args.roomId, userId);

		const text = requireMessageText(args.text);

		// Resolve @mentions to known userProfiles. Unknown handles are dropped
		// silently; they remain in the message text but don't generate a
		// chatMentions row (and thus don't notify anyone).
		//
		// Match logic: a handle like "@alice.smith" matches a profile whose
		// email prefix or slugified name equals "alice.smith". userProfiles is
		// bounded (one row per org member), so a single .take(500) scan is
		// cheap and acceptable here.
		const resolvedMentions = await resolveMentionsToMemberIds(ctx, parseMentionHandles(text));

		// Only mention users who are members of THIS room. Without this filter an
		// @mention in a private channel or DM would write a chatMentions row for a
		// non-member, leaking a preview of the message (and the room name) to
		// someone with no access to the room via `mentions.listMyUnreadMentions`.
		const uniqueMentions: string[] = [];
		for (const memberId of resolvedMentions) {
			const membershipOfMentioned = await getMembership(ctx, args.roomId, memberId);
			if (membershipOfMentioned) uniqueMentions.push(memberId);
		}

		const now = Date.now();
		const messageId = await ctx.db.insert('chatMessages', {
			roomId: args.roomId,
			authorId: userId,
			text,
			mentions: uniqueMentions.length > 0 ? uniqueMentions : undefined,
			attachmentIds: args.attachmentIds && args.attachmentIds.length > 0 ? args.attachmentIds : undefined,
			createdAt: now,
		});

		for (const mentionedMemberId of uniqueMentions) {
			if (mentionedMemberId === userId) continue; // never notify self
			await ctx.db.insert('chatMentions', {
				messageId,
				roomId: args.roomId,
				mentionedMemberId,
				mentioningMemberId: userId,
				createdAt: now,
			});
		}

		// AGGREGATED: the messages module is the only writer of these fields.
		await ctx.db.patch(args.roomId, {
			lastMessageAt: now,
			messageCount: (room.messageCount ?? 0) + 1,
			updatedAt: now,
		});

		// Sender just read their own message.
		await ctx.db.patch(membership._id, { lastReadAt: now });

		// @assistant — when the reserved handle is used and the AI assistant feature
		// is on, post a streaming AI reply visible to the whole room and let the
		// runner fill it in. Soft-checked (no throw): if the feature is off the
		// human message still posts normally, the @assistant just goes unanswered.
		if (isAssistantInvoked(text) && (await isFeatureEnabled(ctx, 'ai.assistant'))) {
			const assistantMessageId = await ctx.db.insert('chatMessages', {
				roomId: args.roomId,
				authorId: ASSISTANT_AUTHOR_ID,
				text: '',
				aiStatus: 'streaming',
				aiPromptMessageId: messageId,
				createdAt: now + 1,
			});
			await ctx.db.patch(args.roomId, {
				lastMessageAt: now + 1,
				messageCount: (room.messageCount ?? 0) + 2,
				updatedAt: now + 1,
			});
			await ctx.scheduler.runAfter(0, internal.assistant.runner.runForChat, {
				roomId: args.roomId,
				assistantMessageId,
				promptMessageId: messageId,
			});
		}

		return messageId;
	},
});

/**
 * Edit your own message. Author-only; admins do not have edit rights to other
 * users' messages.
 */
// authz: author-only — a member may edit only their own chat message (checked below).
export const editMessage = chatMutation({
	args: { messageId: v.id('chatMessages'), text: v.string() },
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);
		const message = await ctx.db.get(args.messageId);
		if (!message || message.deletedAt) {
			throwNotFound('Message');
		}
		if (message.authorId !== userId) {
			throwForbidden('You can only edit your own messages');
		}

		const text = requireMessageText(args.text);
		await ctx.db.patch(args.messageId, { text, editedAt: Date.now() });
	},
});

/**
 * Soft-delete a message. Author OR per-room admin (or chat:manage).
 */
// authz: author, room admin, or org chat:manage may delete (checked below).
export const deleteMessage = chatMutation({
	args: { messageId: v.id('chatMessages') },
	handler: async (ctx, args) => {
		const { userId, role } = await getMutationContext(ctx);
		const message = await ctx.db.get(args.messageId);
		if (!message || message.deletedAt) {
			throwNotFound('Message');
		}
		if (message.authorId !== userId) {
			// Not your message — must be admin in this room OR org chat:manage.
			if (!hasPermission(role, 'chat:manage')) {
				const membership = await getMembership(ctx, message.roomId, userId);
				if (membership?.role !== 'admin') {
					throwForbidden('Only the author or a room admin can delete this message');
				}
			}
		}

		await ctx.db.patch(args.messageId, { deletedAt: Date.now() });
	},
});

/**
 * Mark all messages in a room as read up to `now` (or a provided timestamp).
 * Caller must be a member.
 */
// authz: room membership — only a room member may mark it read (checked below).
export const markRead = chatMutation({
	args: { roomId: v.id('chatRooms'), at: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);
		const membership = await getMembership(ctx, args.roomId, userId);
		if (!membership) return; // tolerate; caller may have just left

		const at = args.at ?? Date.now();
		if (at <= membership.lastReadAt) return;
		await ctx.db.patch(membership._id, { lastReadAt: at });

		// Mark any of the caller's mentions in this room read up to `at`.
		const unreadMentions = await ctx.db
			.query('chatMentions')
			.withIndex('by_mentioned_unread', (q) =>
				q.eq('mentionedMemberId', userId).eq('readAt', undefined),
			)
			.collect(); // bounded: caller's unread mentions (small per-user backlog)
		for (const mention of unreadMentions) {
			if (mention.roomId !== args.roomId) continue;
			if (mention.createdAt > at) continue;
			await ctx.db.patch(mention._id, { readAt: at });
		}
	},
});

/**
 * Compute unread counts for the rooms the caller belongs to.
 *
 * Returns a map keyed by roomId with `{ unreadCount, hasMention }`. Unread is
 * counted as messages with `createdAt > member.lastReadAt`. We cap per-room
 * counting at 100 to stay cheap; "100+" UI is acceptable.
 */
export const myUnreadCounts = chatQuery({
	args: {},
	handler: async (ctx) => {
		const userId = await getUserIdFromSession(ctx);

		const memberships = await ctx.db
			.query('chatRoomMembers')
			.withIndex('by_member', (q) => q.eq('memberId', userId))
			.collect(); // bounded: caller's chat rooms (~tens)

		const result: Record<string, { unreadCount: number; hasMention: boolean }> = {};

		// Unread mentions — single index scan.
		const unreadMentions = await ctx.db
			.query('chatMentions')
			.withIndex('by_mentioned_unread', (q) =>
				q.eq('mentionedMemberId', userId).eq('readAt', undefined),
			)
			.collect(); // bounded: caller's unread mentions (small per-user backlog)
		const mentionRoomIds = new Set(unreadMentions.map((m) => m.roomId.toString()));

		for (const membership of memberships) {
			const recent = await ctx.db
				.query('chatMessages')
				.withIndex('by_room_and_created', (q) =>
					q.eq('roomId', membership.roomId).gt('createdAt', membership.lastReadAt),
				)
				.take(101);
			// Exclude soft-deleted + the user's own messages from the unread count.
			const count = recent.filter((m) => !m.deletedAt && m.authorId !== userId).length;
			result[membership.roomId.toString()] = {
				unreadCount: count,
				hasMention: mentionRoomIds.has(membership.roomId.toString()),
			};
		}
		return result;
	},
});

// ── @assistant reply: internal surface for the conversation runner ───────────

/**
 * Assemble the model context for an @assistant reply: the recent room messages
 * (bounded) mapped to model turns — human messages prefixed with the author's
 * name so the model can follow a multi-party conversation, the assistant's own
 * prior replies as assistant turns. Excludes the streaming placeholder.
 */
export const getAssistantChatContext = internalQuery({
	args: { roomId: v.id('chatRooms'), assistantMessageId: v.id('chatMessages') },
	handler: async (ctx, args) => {
		const room = await ctx.db.get(args.roomId);
		if (!room) return null;
		const recent = await ctx.db
			.query('chatMessages')
			.withIndex('by_room_and_created', (q) => q.eq('roomId', args.roomId))
			.order('desc')
			.take(CHAT_CONTEXT_LIMIT);
		recent.reverse(); // chronological

		const profileCache = new Map<string, ProfileSummary>();
		const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
		for (const m of recent) {
			if (m._id === args.assistantMessageId) continue;
			if (m.deletedAt) continue;
			if (!m.text.trim()) continue;
			if (m.authorId === ASSISTANT_AUTHOR_ID) {
				messages.push({ role: 'assistant', text: m.text });
			} else {
				let p = profileCache.get(m.authorId);
				if (!p) {
					p = await loadProfileSummary(ctx, m.authorId);
					profileCache.set(m.authorId, p);
				}
				const name = p.name ?? p.email ?? 'Member';
				messages.push({ role: 'user', text: `${name}: ${m.text}` });
			}
		}
		return { messages, roomName: room.name };
	},
});

/**
 * Patch the streaming @assistant reply with the latest text + tool-call cards.
 * Returns `{ stop: true }` once the row is no longer streaming or was deleted,
 * signalling the runner to abort.
 */
export const patchAssistantChatMessage = internalMutation({
	args: {
		messageId: v.id('chatMessages'),
		text: v.string(),
		toolCalls: v.optional(v.array(assistantToolCallValidator)),
	},
	handler: async (ctx, args): Promise<{ stop: boolean }> => {
		const msg = await ctx.db.get(args.messageId);
		if (!msg || msg.deletedAt || msg.aiStatus !== 'streaming') return { stop: true };
		await ctx.db.patch(args.messageId, {
			text: args.text,
			...(args.toolCalls ? { toolCalls: args.toolCalls } : {}),
		});
		return { stop: false };
	},
});

/**
 * Finalize the @assistant reply. On error with no streamed text, leaves a short
 * visible fallback (chatMessages has no errorMessage column). A deletion/stop in
 * flight is preserved over a natural finish.
 */
export const finalizeAssistantChatMessage = internalMutation({
	args: {
		messageId: v.id('chatMessages'),
		text: v.string(),
		status: assistantMessageStatusValidator,
		model: v.optional(v.string()),
		tokenUsage: v.optional(tokenUsageValidator),
		errorMessage: v.optional(v.string()),
		toolCalls: v.optional(v.array(assistantToolCallValidator)),
	},
	handler: async (ctx, args) => {
		const msg = await ctx.db.get(args.messageId);
		if (!msg || msg.deletedAt) return;
		const status = msg.aiStatus === 'streaming' ? args.status : msg.aiStatus ?? args.status;
		const finalText =
			args.status === 'error' && !args.text.trim()
				? '⚠️ The assistant could not complete this reply.'
				: args.text;
		await ctx.db.patch(args.messageId, {
			text: finalText,
			aiStatus: status,
			model: args.model,
			tokenUsage: args.tokenUsage,
			...(args.toolCalls ? { toolCalls: args.toolCalls } : {}),
		});
	},
});
