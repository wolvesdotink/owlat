import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	tokenUsageValidator,
	assistantToolCallValidator,
	assistantMessageStatusValidator,
} from '../lib/convexValidators';

/**
 * Internal team chat tables — Slack-style channels + DMs for the single org
 * that owns this deployment.
 *
 * - chatRooms: a channel (named, public/private) or a DM (between participants)
 * - chatRoomMembers: per-room membership + per-room admin role + lastReadAt
 * - chatMessages: messages posted to a room
 * - chatMentions: denormalized @-mention rows for fast unread queries
 *
 * Spread into `defineSchema()` from schema.ts via `...chatTables`.
 */
export const chatTables = {
	chatRooms: defineTable({
		// 'channel' = named room with public/private visibility.
		// 'dm' = direct message between a fixed set of participants (always private).
		kind: v.union(v.literal('channel'), v.literal('dm')),
		// For channels: the explicit channel name (e.g. "general").
		// For DMs: a denormalized label assembled from participant names —
		// the canonical participant list is `chatRoomMembers`.
		name: v.string(),
		// Lowercase channel name for uniqueness lookups (channels only).
		// For DMs: a sorted-comma-joined memberId list so we can deduplicate
		// "DM with the same people" lookups via `by_kind_and_normalized_name`.
		normalizedName: v.string(),
		description: v.optional(v.string()),
		// Channels: 'public' (any org member can join) or 'private' (invite-only).
		// DMs: always 'private'.
		visibility: v.union(v.literal('public'), v.literal('private')),
		createdBy: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
		archivedAt: v.optional(v.number()),
		// Inline-linked external email thread (the "Slack channel discussing an
		// inbox conversation" feature). Channels only; DMs are not linked.
		linkedInboxThreadId: v.optional(v.id('conversationThreads')),
		// AGGREGATED — touched by messages.sendMessage / deleteMessage. Do not
		// write from user-facing mutations directly.
		lastMessageAt: v.number(),
		messageCount: v.number(),
	})
		.index('by_kind', ['kind'])
		.index('by_visibility', ['visibility'])
		.index('by_last_message_at', ['lastMessageAt'])
		.index('by_kind_and_normalized_name', ['kind', 'normalizedName'])
		.index('by_linked_inbox_thread', ['linkedInboxThreadId']),

	chatRoomMembers: defineTable({
		roomId: v.id('chatRooms'),
		// BetterAuth user ID (string). The org's `member` table is the source of
		// truth for org membership; this row authorizes a single user inside
		// one chat room.
		memberId: v.string(),
		// Per-room role. 'admin' can rename / archive / manage membership /
		// link or unlink the email thread. Org owners/admins additionally have
		// `chat:manage`, which can override this on any room.
		role: v.union(v.literal('admin'), v.literal('member')),
		joinedAt: v.number(),
		// Used to compute unread counts. Updated whenever the user reads the
		// room (scroll-to-bottom or explicit markRead).
		lastReadAt: v.number(),
		// Optional mute until timestamp (future per-user notification control).
		mutedUntil: v.optional(v.number()),
	})
		.index('by_room', ['roomId'])
		.index('by_member', ['memberId'])
		.index('by_room_and_member', ['roomId', 'memberId']),

	chatMessages: defineTable({
		roomId: v.id('chatRooms'),
		// BetterAuth user ID of the author, OR the reserved assistant identity
		// (`ASSISTANT_AUTHOR_ID` in chat/_helpers.ts) for an @assistant reply. The
		// reserved id is not a valid BetterAuth user id, so it can never collide
		// with a real member and a real member can never author "as the assistant".
		authorId: v.string(),
		text: v.string(),
		// Denormalized list of memberIds mentioned in `text`. Drives the
		// chatMentions writes at send time; consumers should read mentions
		// from the chatMentions table for unread bookkeeping.
		mentions: v.optional(v.array(v.string())),
		// References to mediaAssets rows (also a v.id table, so we use string IDs
		// stored as-is; Convex permits id<>id refs but the union arr is awkward).
		attachmentIds: v.optional(v.array(v.id('mediaAssets'))),
		editedAt: v.optional(v.number()),
		// Soft-delete: keeps the row so threading/replies stay intact but the
		// renderer shows "this message was deleted".
		deletedAt: v.optional(v.number()),
		createdAt: v.number(),
		// ── AI assistant reply fields (set ONLY when authorId === ASSISTANT_AUTHOR_ID) ──
		// Streaming lifecycle of an @assistant reply. The runner inserts the row
		// `streaming` + empty and patches `text`/`toolCalls` in place (throttled)
		// until terminal. Absent on every human message.
		aiStatus: v.optional(assistantMessageStatusValidator),
		// Tool-call transcript for the reply (display-only cards).
		toolCalls: v.optional(v.array(assistantToolCallValidator)),
		// Model + token accounting for the reply.
		model: v.optional(v.string()),
		tokenUsage: v.optional(tokenUsageValidator),
		// The human message whose @assistant mention triggered this reply
		// (observability / threading of the request→reply pair).
		aiPromptMessageId: v.optional(v.id('chatMessages')),
	})
		.index('by_room', ['roomId'])
		.index('by_room_and_created', ['roomId', 'createdAt'])
		.index('by_author', ['authorId']),

	chatMentions: defineTable({
		messageId: v.id('chatMessages'),
		roomId: v.id('chatRooms'),
		mentionedMemberId: v.string(),
		mentioningMemberId: v.string(),
		readAt: v.optional(v.number()),
		createdAt: v.number(),
	})
		.index('by_mentioned_unread', ['mentionedMemberId', 'readAt'])
		.index('by_message', ['messageId'])
		.index('by_room', ['roomId']),
};
