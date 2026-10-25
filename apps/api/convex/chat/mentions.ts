/**
 * @-mention helpers, the unread-mention feed, and the mark-read mutation.
 *
 * The actual mention rows are written from `messages.sendMessage`. This file
 * owns the resolver (text handles -> memberIds) and the read/list queries.
 */

import { v } from 'convex/values';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { getMutationContext, getUserIdFromSession } from '../lib/sessionOrganization';
import { chatQuery, chatMutation, loadRoomReadAccess } from './_helpers';
import { getOrThrow } from '../_utils/errors';
import { batchGet } from '../_utils/batchLoader';

/**
 * Resolve `@handle` strings into authUserIds. Handles match either the email
 * local-part or the slugified profile name. Unknown handles drop silently —
 * the text remains in the message but no chatMentions row is written.
 *
 * One scan over `userProfiles` (bounded by org size) handles every handle.
 */
export async function resolveMentionsToMemberIds(
	ctx: QueryCtx | MutationCtx,
	handles: string[]
): Promise<string[]> {
	if (handles.length === 0) return [];

	const candidates = await ctx.db.query('userProfiles').take(500);
	const lowerHandles = new Set(handles.map((h) => h.toLowerCase()));
	const resolved: string[] = [];

	for (const profile of candidates) {
		if (profile.deletedAt) continue;
		const emailPrefix = (profile.email ?? '').split('@')[0]?.toLowerCase() ?? '';
		const nameSlug = (profile.name ?? '').toLowerCase().replace(/\s+/g, '.');
		if (lowerHandles.has(emailPrefix) || (nameSlug && lowerHandles.has(nameSlug))) {
			resolved.push(profile.authUserId);
		}
	}
	return [...new Set(resolved)];
}

/**
 * List the caller's unread mentions, newest first. Each row includes a small
 * preview of the message that triggered the mention.
 */
// authz: self — only the caller's own mentions, each still readable under loadRoomReadAccess (chat/_helpers.ts)
export const listMyUnreadMentions = chatQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const userId = await getUserIdFromSession(ctx);
		return await loadVisibleUnreadMentions(ctx, userId, args.limit);
	},
});

/**
 * How many rows `listMyUnreadMentions` returns for the same `limit`, without
 * shipping them (plan 2.11). The shell's Answer badge counts the mentions the
 * Answer page would show, so a mention of a deleted message or of a mail
 * thread the caller can no longer read is not counted; `countMyUnreadMentions`
 * stays the raw index count the chat badge uses.
 */
// authz: self — only the caller's own mentions, each still readable under loadRoomReadAccess (chat/_helpers.ts)
export const countMyVisibleUnreadMentions = chatQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args, session): Promise<number> =>
		(await loadVisibleUnreadMentions(ctx, session.userId, args.limit)).length,
});

/** The caller's unread mentions the feed shows (message still there, room still readable). */
async function loadVisibleUnreadMentions(ctx: QueryCtx, userId: string, requested?: number) {
	const limit = Math.max(1, Math.min(requested ?? 50, 200));
	const mentions = await ctx.db
		.query('chatMentions')
		.withIndex('by_mentioned_unread', (q) =>
			q.eq('mentionedMemberId', userId).eq('readAt', undefined)
		)
		.order('desc')
		.take(limit);

	// A page of mentions points at independent messages, and usually at only
	// a few distinct rooms — two batched reads instead of two per mention.
	const [messages, rooms] = await Promise.all([
		batchGet(
			ctx,
			mentions.map((mention) => mention.messageId)
		),
		batchGet(
			ctx,
			mentions.map((mention) => mention.roomId)
		),
	]);

	// A mention is shown only while the caller can still read its room: a
	// private channel or DM they left or were removed from drops out (the
	// mention row survives the removal), and a mail-thread discussion needs its
	// mailbox to be readable now, not when the mention was written. One read
	// check per distinct room on the page.
	const roomAccess = new Map<string, Awaited<ReturnType<typeof loadRoomReadAccess>>>();

	const result = [];
	for (const mention of mentions) {
		const message = messages.get(mention.messageId);
		if (!message || message.deletedAt) continue;
		const room = rooms.get(mention.roomId);
		if (!room) continue;
		const key = room._id.toString();
		if (!roomAccess.has(key)) {
			roomAccess.set(key, await loadRoomReadAccess(ctx, room, userId));
		}
		const access = roomAccess.get(key);
		if (!access) continue;
		// A mail-thread discussion points at the email thread, not a chat room.
		const thread = access.discussion?.thread ?? null;
		const mailThread: {
			threadId: Id<'mailThreads'>;
			mailboxId: Id<'mailboxes'>;
			latestMessageId: Id<'mailMessages'> | null;
		} | null = thread
			? {
					threadId: thread._id,
					mailboxId: thread.mailboxId,
					latestMessageId: thread.latestMessageId ?? null,
				}
			: null;
		const roomName = thread ? thread.latestSubject : room.name;
		result.push({
			_id: mention._id,
			roomId: mention.roomId,
			roomName,
			roomKind: room.kind,
			mailThread,
			messageId: mention.messageId,
			messagePreview: message.text.slice(0, 180),
			mentioningMemberId: mention.mentioningMemberId,
			createdAt: mention.createdAt,
		});
	}
	return result;
}

/**
 * Compact count of unread mentions for the nav badge.
 */
// authz: self — counts only the caller's own mention rows (keyed by the session
// user) and returns no room or message content, so it stays the raw row count.
export const countMyUnreadMentions = chatQuery({
	args: {},
	handler: async (ctx) => {
		const userId = await getUserIdFromSession(ctx);
		const mentions = await ctx.db
			.query('chatMentions')
			.withIndex('by_mentioned_unread', (q) =>
				q.eq('mentionedMemberId', userId).eq('readAt', undefined)
			)
			.take(101);
		return mentions.length;
	},
});

/** Mark a single mention as read. */
// authz: self — a member marks only their own mentions read.
export const markMentionRead = chatMutation({
	args: { mentionId: v.id('chatMentions') },
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);
		const mention = await getOrThrow(ctx, args.mentionId, 'Mention');
		if (mention.mentionedMemberId !== userId) {
			// Silently no-op — don't leak existence of others' mentions.
			return;
		}
		if (mention.readAt) return;
		await ctx.db.patch(args.mentionId, { readAt: Date.now() });
	},
});

/**
 * List org members the caller can @-mention. Used by the mention-picker UI.
 *
 * Filtered by an optional `query` prefix (case-insensitive match on name or
 * email prefix). The org member table is small so a single scan suffices.
 */
// all-members: the org member directory (name, email, avatar) every member sees
// in the mention picker; deleted profiles are excluded.
export const searchOrgMembersForMention = chatQuery({
	args: { query: v.optional(v.string()) },
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		const q = args.query?.trim().toLowerCase() ?? '';

		const profiles = await ctx.db.query('userProfiles').take(500);
		const matches = profiles
			.filter((p) => !p.deletedAt)
			.filter((p) => {
				if (!q) return true;
				const emailPrefix = (p.email ?? '').split('@')[0]?.toLowerCase() ?? '';
				const nameSlug = (p.name ?? '').toLowerCase();
				return emailPrefix.includes(q) || nameSlug.includes(q);
			})
			.slice(0, 25);

		return matches.map((p) => ({
			memberId: p.authUserId,
			name: p.name ?? null,
			email: p.email ?? null,
			image: p.image ?? null,
			// Suggested @-handle derived from the email local-part.
			handle: (p.email ?? '').split('@')[0]?.toLowerCase() ?? null,
		}));
	},
});
