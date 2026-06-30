/**
 * Personal AI assistant — conversation data plane.
 *
 * Owns the private (owner-scoped) conversation CRUD + the message read/send
 * surface for `/dashboard/assistant`, plus the internal query/mutations the
 * streaming runner (`assistant/runner.ts`, a Node action) calls to read context
 * and patch the assistant turn in place. Default runtime (holds queries +
 * mutations); the LLM work lives in the sibling `runner.ts` ('use node').
 *
 * Privacy: every read/write is gated on `convo.ownerId === caller` — a member
 * can only ever see and drive their own conversations.
 */

import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { internalQuery, internalMutation } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { getMutationContext, getUserIdFromSession } from '../lib/sessionOrganization';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { rateLimiter } from '../rateLimiter';
import { throwInvalidInput, throwNotFound, throwRateLimited, throwForbidden } from '../_utils/errors';
import {
	tokenUsageValidator,
	assistantToolCallValidator,
	assistantMessageStatusValidator,
} from '../lib/convexValidators';

const MESSAGE_MAX = 8000;
const TITLE_MAX = 120;
/** How many prior turns to replay into the model context. */
const HISTORY_LIMIT = 40;
const LIST_LIMIT = 100;
const MESSAGES_LIMIT = 500;

/** Derive a conversation title from the first user message (single line). */
function deriveTitle(text: string): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine || 'New conversation';
}

/** Load a conversation the caller owns, or throw. */
async function loadOwnedConversation(
	ctx: QueryCtx | MutationCtx,
	conversationId: Id<'aiConversations'>,
	userId: string,
): Promise<Doc<'aiConversations'>> {
	const convo = await ctx.db.get(conversationId);
	if (!convo || convo.deletedAt) throwNotFound('Conversation');
	if (convo.ownerId !== userId) throwForbidden('You do not have access to this conversation');
	return convo;
}

// ── Public, owner-scoped surface ────────────────────────────────────────────

/** Start a new (empty) conversation. */
// all-members: a member manages their own private assistant conversations.
export const createConversation = authedMutation({
	args: {},
	handler: async (ctx): Promise<Id<'aiConversations'>> => {
		await assertFeatureEnabled(ctx, 'ai.assistant');
		const { userId } = await getMutationContext(ctx);
		const now = Date.now();
		return ctx.db.insert('aiConversations', {
			ownerId: userId,
			title: 'New conversation',
			createdAt: now,
			updatedAt: now,
			lastMessageAt: now,
			messageCount: 0,
		});
	},
});

/** List the caller's conversations, most-recently-active first. */
// all-members: a member lists their own private assistant conversations (owner-scoped query).
export const listConversations = authedQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'ai.assistant');
		const userId = await getUserIdFromSession(ctx);
		const rows = await ctx.db
			.query('aiConversations')
			.withIndex('by_owner_and_last_message', (q) => q.eq('ownerId', userId))
			.order('desc')
			.take(LIST_LIMIT);
		const result: Array<{
			_id: Id<'aiConversations'>;
			title: string;
			lastMessageAt: number;
			messageCount: number;
			updatedAt: number;
		}> = [];
		for (const r of rows) {
			if (r.deletedAt) continue;
			result.push({
				_id: r._id,
				title: r.title,
				lastMessageAt: r.lastMessageAt,
				messageCount: r.messageCount,
				updatedAt: r.updatedAt,
			});
		}
		return result;
	},
});

/** Fetch one conversation's metadata (owner-scoped). */
// all-members: a member reads their own private assistant conversation (ownership checked).
export const getConversation = authedQuery({
	args: { conversationId: v.id('aiConversations') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'ai.assistant');
		const userId = await getUserIdFromSession(ctx);
		const convo = await ctx.db.get(args.conversationId);
		if (!convo || convo.deletedAt || convo.ownerId !== userId) return null;
		return { _id: convo._id, title: convo.title, lastMessageAt: convo.lastMessageAt, messageCount: convo.messageCount };
	},
});

/**
 * Reactive message feed for a conversation. Soft-fails to [] for a non-owner so
 * the streaming subscription never leaks another member's conversation.
 */
// all-members: a member reads messages of their own private conversation (ownership checked).
export const listMessages = authedQuery({
	args: { conversationId: v.id('aiConversations') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'ai.assistant');
		const userId = await getUserIdFromSession(ctx);
		const convo = await ctx.db.get(args.conversationId);
		if (!convo || convo.deletedAt || convo.ownerId !== userId) return [];
		// Take the NEWEST MESSAGES_LIMIT (desc) then restore chronological order —
		// an asc take would return the oldest rows and drop the latest turns
		// (incl. the streaming placeholder) once a conversation exceeds the cap.
		const newest = await ctx.db
			.query('aiMessages')
			.withIndex('by_conversation_and_created', (q) => q.eq('conversationId', args.conversationId))
			.order('desc')
			.take(MESSAGES_LIMIT);
		const msgs = newest.reverse();
		return msgs.map((m) => ({
			_id: m._id,
			role: m.role,
			text: m.text,
			status: m.status,
			toolCalls: m.toolCalls ?? [],
			errorMessage: m.errorMessage ?? null,
			model: m.model ?? null,
			tokenUsage: m.tokenUsage ?? null,
			createdAt: m.createdAt,
		}));
	},
});

/** Rename a conversation. */
// all-members: a member manages their own private assistant conversations.
export const renameConversation = authedMutation({
	args: { conversationId: v.id('aiConversations'), title: v.string() },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'ai.assistant');
		const { userId } = await getMutationContext(ctx);
		await loadOwnedConversation(ctx, args.conversationId, userId);
		const title = args.title.trim();
		if (!title) throwInvalidInput('Title cannot be empty');
		if (title.length > TITLE_MAX) throwInvalidInput(`Title must be ${TITLE_MAX} characters or fewer`);
		await ctx.db.patch(args.conversationId, { title, updatedAt: Date.now() });
	},
});

/** Soft-delete a conversation (user-initiated). */
// all-members: a member manages their own private assistant conversations.
export const deleteConversation = authedMutation({
	args: { conversationId: v.id('aiConversations') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'ai.assistant');
		const { userId } = await getMutationContext(ctx);
		await loadOwnedConversation(ctx, args.conversationId, userId);
		await ctx.db.patch(args.conversationId, { deletedAt: Date.now(), updatedAt: Date.now() });
	},
});

/**
 * Post a user message and kick off the assistant's streamed reply. Inserts the
 * user turn + an empty `streaming` assistant placeholder, then schedules the
 * Node runner, which patches the placeholder in place as tokens arrive.
 */
// all-members: a member sends into their own private assistant conversation (ownership checked).
export const sendMessage = authedMutation({
	args: { conversationId: v.id('aiConversations'), text: v.string() },
	handler: async (ctx, args): Promise<{ assistantMessageId: Id<'aiMessages'> }> => {
		await assertFeatureEnabled(ctx, 'ai.assistant');
		const { userId } = await getMutationContext(ctx);
		const convo = await loadOwnedConversation(ctx, args.conversationId, userId);

		const text = args.text.trim();
		if (!text) throwInvalidInput('Message cannot be empty');
		if (text.length > MESSAGE_MAX) throwInvalidInput(`Message exceeds ${MESSAGE_MAX} characters`);

		const rl = await rateLimiter.limit(ctx, 'assistantChatPerUser', { key: userId });
		if (!rl.ok) throwRateLimited('The assistant is busy — try again in a moment.', rl.retryAfter);

		const now = Date.now();
		await ctx.db.insert('aiMessages', {
			conversationId: args.conversationId,
			ownerId: userId,
			role: 'user',
			text,
			status: 'complete',
			createdAt: now,
		});
		const assistantMessageId = await ctx.db.insert('aiMessages', {
			conversationId: args.conversationId,
			ownerId: userId,
			role: 'assistant',
			text: '',
			status: 'streaming',
			createdAt: now + 1,
		});

		await ctx.db.patch(args.conversationId, {
			lastMessageAt: now,
			updatedAt: now,
			messageCount: convo.messageCount + 2,
			...(convo.messageCount === 0 ? { title: deriveTitle(text) } : {}),
		});

		await ctx.scheduler.runAfter(0, internal.assistant.runner.run, {
			conversationId: args.conversationId,
			assistantMessageId,
			ownerId: userId,
		});

		return { assistantMessageId };
	},
});

/** Request the in-flight assistant turn to stop streaming. */
// all-members: a member stops generation only on their own message (ownership checked).
export const stopGeneration = authedMutation({
	args: { messageId: v.id('aiMessages') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'ai.assistant');
		const { userId } = await getMutationContext(ctx);
		const msg = await ctx.db.get(args.messageId);
		if (!msg || msg.ownerId !== userId) return; // never leak existence
		if (msg.status === 'streaming') {
			await ctx.db.patch(args.messageId, { status: 'stopped' });
		}
	},
});

// ── Internal surface for the runner ─────────────────────────────────────────

/**
 * Assemble the model context for a turn: the completed prior turns (bounded),
 * the owner's display name for the system prompt. The `streaming` placeholder
 * and any failed/stopped turns are excluded so we never replay them.
 */
export const getRunContext = internalQuery({
	args: { conversationId: v.id('aiConversations'), assistantMessageId: v.id('aiMessages') },
	handler: async (ctx, args) => {
		const convo = await ctx.db.get(args.conversationId);
		if (!convo) return null;
		// Take the NEWEST MESSAGES_LIMIT (desc) then restore chronological order so
		// the latest turns (and the just-sent user message) are what gets replayed,
		// not the oldest rows once a conversation exceeds the cap.
		const all = (await ctx.db
			.query('aiMessages')
			.withIndex('by_conversation_and_created', (q) => q.eq('conversationId', args.conversationId))
			.order('desc')
			.take(MESSAGES_LIMIT)).reverse();
		// Replay only the completed prior turns — skip the streaming placeholder
		// and any failed/stopped turns so we never feed a broken turn back in.
		const completed: Array<{ role: 'user' | 'assistant'; text: string }> = [];
		for (const m of all) {
			if (m._id === args.assistantMessageId) continue;
			if (m.status !== 'complete') continue;
			if (m.text.trim().length === 0) continue;
			completed.push({ role: m.role, text: m.text });
		}
		const history = completed.slice(-HISTORY_LIMIT);
		const profile = await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', convo.ownerId))
			.first();
		return { messages: history, userName: profile?.name ?? null };
	},
});

/**
 * Patch the streaming assistant row with the latest accumulated text + tool-call
 * cards. Returns `{ stop: true }` when the row is no longer `streaming` (the
 * user pressed Stop, or it was finalized), signalling the runner to abort.
 */
export const patchAssistantMessage = internalMutation({
	args: {
		messageId: v.id('aiMessages'),
		text: v.string(),
		toolCalls: v.optional(v.array(assistantToolCallValidator)),
	},
	handler: async (ctx, args): Promise<{ stop: boolean }> => {
		const msg = await ctx.db.get(args.messageId);
		if (!msg || msg.status !== 'streaming') return { stop: true };
		await ctx.db.patch(args.messageId, {
			text: args.text,
			...(args.toolCalls ? { toolCalls: args.toolCalls } : {}),
		});
		return { stop: false };
	},
});

/**
 * Finalize the assistant turn. Preserves a user-set terminal status (`stopped`)
 * over the runner's natural finish, but always writes the final text + usage.
 */
export const finalizeAssistantMessage = internalMutation({
	args: {
		messageId: v.id('aiMessages'),
		text: v.string(),
		status: assistantMessageStatusValidator,
		model: v.optional(v.string()),
		tokenUsage: v.optional(tokenUsageValidator),
		errorMessage: v.optional(v.string()),
		toolCalls: v.optional(v.array(assistantToolCallValidator)),
	},
	handler: async (ctx, args) => {
		const msg = await ctx.db.get(args.messageId);
		if (!msg) return;
		// A user 'stopped' wins over the runner's natural 'complete'.
		const status = msg.status === 'streaming' ? args.status : msg.status;
		await ctx.db.patch(args.messageId, {
			text: args.text,
			status,
			model: args.model,
			tokenUsage: args.tokenUsage,
			errorMessage: args.errorMessage,
			...(args.toolCalls ? { toolCalls: args.toolCalls } : {}),
		});
		const now = Date.now();
		await ctx.db.patch(msg.conversationId, { lastMessageAt: now, updatedAt: now });
	},
});
