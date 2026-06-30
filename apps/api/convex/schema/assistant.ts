import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	tokenUsageValidator,
	assistantToolCallValidator,
	assistantMessageStatusValidator,
} from '../lib/convexValidators';

/**
 * Personal AI assistant — the private, multi-turn, streaming, tool-calling chat
 * surface at `/dashboard/assistant`. One conversation owns an append-only list
 * of turns; the engine (`assistant/runner.ts`) drives a `streamText` tool loop
 * and patches the streaming assistant row in place (throttled), so the reactive
 * `useConvexQuery` subscription renders tokens as they arrive.
 *
 * Privacy model: a conversation is OWNED by one user (`ownerId` = BetterAuth
 * user id) and is only ever readable by that user — distinct from the org-shared
 * team-chat rooms, which is why these live in their own tables rather than on
 * `chatMessages`. The `@assistant`-in-team-chat surface reuses `chatMessages`
 * instead (see `schema/chat.ts`); both share the one engine.
 *
 * Spread into `defineSchema()` from schema.ts via `...assistantTables`.
 */
export const assistantTables = {
	// One private assistant conversation (a "chat" in the ChatGPT sense).
	aiConversations: defineTable({
		// BetterAuth user id — the sole owner. Reads/writes are owner-scoped; no
		// other member can see another user's conversations.
		ownerId: v.string(),
		// Display title. Seeded to a placeholder, then derived from the first user
		// message (or renamed by the user).
		title: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
		// AGGREGATED — bumped by the messages writer (sendMessage / runner). Drives
		// the conversation-list ordering and "empty conversation" cleanup.
		lastMessageAt: v.number(),
		messageCount: v.number(),
		// Soft-delete: user-initiated deletes mark the row; list queries filter it.
		deletedAt: v.optional(v.number()),
	})
		.index('by_owner', ['ownerId'])
		// Conversation list: owner leads, lastMessageAt orders within it (desc).
		.index('by_owner_and_last_message', ['ownerId', 'lastMessageAt']),

	// One turn in a conversation. `user` turns are inserted whole; `assistant`
	// turns start empty + `streaming` and accumulate text/toolCalls in place.
	aiMessages: defineTable({
		conversationId: v.id('aiConversations'),
		// Denormalized owner for defense-in-depth scoping + bulk data export/erase.
		ownerId: v.string(),
		role: v.union(v.literal('user'), v.literal('assistant')),
		// Accumulates during streaming for assistant turns; the whole user text for
		// user turns.
		text: v.string(),
		status: assistantMessageStatusValidator,
		// Tool-call transcript (display-only cards). User turns omit it.
		toolCalls: v.optional(v.array(assistantToolCallValidator)),
		// Set when status === 'error'.
		errorMessage: v.optional(v.string()),
		// Model + token accounting for assistant turns (per-conversation cost UI).
		model: v.optional(v.string()),
		tokenUsage: v.optional(tokenUsageValidator),
		createdAt: v.number(),
	})
		.index('by_conversation_and_created', ['conversationId', 'createdAt'])
		.index('by_owner', ['ownerId']),
};
