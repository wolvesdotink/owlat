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
import { chatQuery, chatMutation, loadDiscussionMailboxForSession } from './_helpers';
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
export const listMyUnreadMentions = chatQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const userId = await getUserIdFromSession(ctx);
		const limit = Math.max(1, Math.min(args.limit ?? 50, 200));

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

		// A mention in a mail-thread discussion points at the email thread, not a
		// chat room, and is only shown while the caller can still read that
		// thread's mailbox (access can be revoked after the mention was written).
		// One mailbox check per distinct discussion room on the page.
		const discussionAccess = new Map<
			string,
			Awaited<ReturnType<typeof loadDiscussionMailboxForSession>>
		>();

		const result = [];
		for (const mention of mentions) {
			const message = messages.get(mention.messageId);
			if (!message || message.deletedAt) continue;
			const room = rooms.get(mention.roomId);
			if (!room) continue;
			let mailThread: {
				threadId: Id<'mailThreads'>;
				mailboxId: Id<'mailboxes'>;
				latestMessageId: Id<'mailMessages'> | null;
			} | null = null;
			let roomName = room.name;
			if (room.purpose) {
				const key = room._id.toString();
				if (!discussionAccess.has(key)) {
					discussionAccess.set(key, await loadDiscussionMailboxForSession(ctx, room));
				}
				const access = discussionAccess.get(key);
				if (!access) continue;
				mailThread = {
					threadId: access.thread._id,
					mailboxId: access.thread.mailboxId,
					latestMessageId: access.thread.latestMessageId ?? null,
				};
				roomName = access.thread.latestSubject;
			}
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
	},
});

/**
 * Compact count of unread mentions for the nav badge.
 */
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
