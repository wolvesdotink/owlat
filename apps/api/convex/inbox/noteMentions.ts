/**
 * @-mentions in internal notes: who a note reaches, the rows that remember it,
 * the notice the mentioned person sees, and the Team Inbox's Mentions filter.
 *
 * A mention notifies through the surface assignments already use: an
 * `inboxAssignmentNotices` row of kind `mention`, which the person's session
 * picks up from `inbox.queries.pendingAssignments` (in-app toast, plus a
 * desktop notification on the desktop app). There is no second notification
 * center. The `threadNoteMentions` rows behind it are what the Mentions filter
 * reads, and what an edit or delete takes back.
 *
 * Only Team Inbox readers (owners and admins) can be mentioned: the handles in
 * a body resolve against them alone, so a note can never notify someone who
 * cannot open the thread.
 */

import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { publicQuery } from '../lib/authedFunctions';
import { isFeatureEnabled } from '../lib/featureFlags';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { loadLiveUserProfile } from '../lib/userProfiles';
import { parseMentionHandles } from '@owlat/shared/chatMentions';
import { isSharedInboxReader, listSharedInboxReaderIds } from './access';
import { enrichThreadRows } from './queries';
import {
	MENTION_SCAN_LIMIT,
	diffMentions,
	resolveMentionedUserIds,
	type MentionCandidate,
} from './noteRules';

/**
 * The Team Inbox readers `body` mentions. Reads the reader roster only when the
 * body holds a handle at all, so a note without one costs nothing extra.
 */
export async function resolveNoteMentions(
	ctx: MutationCtx,
	body: string,
	authorId: string
): Promise<string[]> {
	if (parseMentionHandles(body).length === 0) return [];
	const readerIds = await listSharedInboxReaderIds(ctx);
	const candidates: MentionCandidate[] = [];
	for (const userId of readerIds) {
		const profile = await loadLiveUserProfile(ctx, userId);
		if (!profile) continue;
		candidates.push({ userId, email: profile.email ?? null, name: profile.name ?? null });
	}
	return resolveMentionedUserIds(body, candidates, authorId);
}

/**
 * Bring a note's mention rows in line with `next` and notify whoever is newly
 * mentioned. `previous` is what the note mentioned before this write (empty
 * for a new note). A person mentioned again in an edit is not notified twice.
 */
export async function syncNoteMentions(
	ctx: MutationCtx,
	note: Pick<Doc<'threadNotes'>, '_id' | 'threadId'>,
	previous: readonly string[],
	next: readonly string[],
	notice: { subject: string; authorName: string; now: number }
): Promise<void> {
	const { added, removed } = diffMentions(previous, next);
	if (removed.length > 0) {
		const rows = await ctx.db
			.query('threadNoteMentions')
			.withIndex('by_note', (q) => q.eq('noteId', note._id))
			.collect(); // bounded: one note's mentions (≤ MAX_NOTE_MENTIONS)
		for (const row of rows) {
			if (removed.includes(row.userId)) await ctx.db.delete(row._id);
		}
	}
	for (const userId of added) {
		await ctx.db.insert('threadNoteMentions', {
			noteId: note._id,
			threadId: note.threadId,
			userId,
			createdAt: notice.now,
		});
		await ctx.db.insert('inboxAssignmentNotices', {
			kind: 'mention',
			userId,
			threadId: note.threadId,
			noteId: note._id,
			subject: notice.subject,
			assignedByName: notice.authorName,
			createdAt: notice.now,
		});
	}
}

/** Drop every mention row of a note (it was deleted). */
export async function clearNoteMentions(ctx: MutationCtx, noteId: Id<'threadNotes'>) {
	const rows = await ctx.db
		.query('threadNoteMentions')
		.withIndex('by_note', (q) => q.eq('noteId', noteId))
		.collect(); // bounded: one note's mentions (≤ MAX_NOTE_MENTIONS)
	for (const row of rows) await ctx.db.delete(row._id);
}

interface MentionedThread {
	threadId: Id<'conversationThreads'>;
	/** The newest note mentioning the viewer on this thread. */
	mentionedAt: number;
}

/**
 * The threads whose notes mention `userId`, newest mention first, one entry
 * per thread. Reads the newest {@link MENTION_SCAN_LIMIT} mention rows.
 */
async function loadMentionedThreads(ctx: QueryCtx, userId: string): Promise<MentionedThread[]> {
	const rows = await ctx.db
		.query('threadNoteMentions')
		.withIndex('by_user_and_created', (q) => q.eq('userId', userId))
		.order('desc')
		.take(MENTION_SCAN_LIMIT);
	const seen = new Set<string>();
	const threads: MentionedThread[] = [];
	for (const row of rows) {
		if (seen.has(row.threadId)) continue;
		seen.add(row.threadId);
		threads.push({ threadId: row.threadId, mentionedAt: row.createdAt });
	}
	return threads;
}

/** Whether the viewer has not opened the thread since they were mentioned on it. */
async function isUnreadMention(ctx: QueryCtx, userId: string, mention: MentionedThread) {
	const read = await ctx.db
		.query('threadReads')
		.withIndex('by_user_thread', (q) => q.eq('userId', userId).eq('threadId', mention.threadId))
		.unique();
	return mention.mentionedAt > (read?.lastSeenAt ?? 0);
}

/**
 * The Mentions filter: the threads a teammate mentioned the viewer on, newest
 * mention first, as the same rows `listThreads` returns plus `mentionedAt` and
 * `unreadMention`. One page (`nextCursor` is always null), like the search
 * path. Soft-auth: empty for anyone who cannot read the Team Inbox.
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const listMentionedThreads = publicQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session) || !(await isFeatureEnabled(ctx, 'inbox'))) {
			return { threads: [], nextCursor: null };
		}
		const viewerId = session.userId;
		const limit = Math.max(1, Math.min(args.limit ?? 50, 100));
		const mentioned = (await loadMentionedThreads(ctx, viewerId)).slice(0, limit);
		const loaded = await Promise.all(
			mentioned.map(async (mention) => ({ mention, thread: await ctx.db.get(mention.threadId) }))
		);
		const present = loaded.filter(
			(entry): entry is { mention: MentionedThread; thread: Doc<'conversationThreads'> } =>
				entry.thread !== null
		);
		const rows = await enrichThreadRows(
			ctx,
			present.map((entry) => entry.thread),
			viewerId
		);
		const threads = await Promise.all(
			rows.map(async (row, index) => {
				const mention = present[index]!.mention;
				return {
					...row,
					mentionedAt: mention.mentionedAt,
					unreadMention: await isUnreadMention(ctx, viewerId, mention),
				};
			})
		);
		return { threads, nextCursor: null };
	},
});

/**
 * How many threads mention the viewer in a note they have not seen since: the
 * badge on the Mentions filter. Opening the thread clears it (its read marker
 * moves past the mention). Soft-auth: 0 for non-readers.
 */
// public: soft-auth — admin-only shared inbox; returns 0 for non-admins
export const countUnreadMentions = publicQuery({
	args: {},
	handler: async (ctx): Promise<number> => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session) || !(await isFeatureEnabled(ctx, 'inbox'))) return 0;
		const viewerId = session.userId;
		const mentioned = await loadMentionedThreads(ctx, viewerId);
		const unread = await Promise.all(mentioned.map((m) => isUnreadMention(ctx, viewerId, m)));
		return unread.filter(Boolean).length;
	},
});
