/**
 * Internal notes on Team Inbox threads — the team talking about a thread
 * inside it, where the customer never sees it.
 *
 * A note sits between the messages of the thread view, in a tinted card that
 * says only the team sees it. It is plain text with `@handle` mentions
 * (`noteMentions.ts`). Its author can edit it; its author or an admin can
 * delete it, which leaves a "Note deleted" tombstone in its place.
 *
 * Notes never leave Owlat. They live in their own table, and none of the paths
 * that send or export mail read it: outbound replies, quoted replies, follow-ups,
 * the contact's data export, webhooks and every agent and assistant prompt are
 * built from messages, never from here (`__tests__/notesStayInternal.test.ts`
 * lists the modules allowed to read `threadNotes`). They do go into their
 * author's account export, and member erasure anonymizes the author.
 *
 * Access follows the rest of the shared inbox (ADR-0040): writes go through
 * `adminMutation`, reads are soft-auth `publicQuery`s that return empty for
 * anyone who is not a Team Inbox reader. No audit-log entry: a note is team
 * conversation, like chat, not an action on the record.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { adminMutation, publicQuery } from '../lib/authedFunctions';
import { assertFeatureEnabled, isFeatureEnabled } from '../lib/featureFlags';
import {
	getBetterAuthSessionWithRole,
	hasPermission,
	requirePermission,
	type OrganizationRole,
} from '../lib/sessionOrganization';
import { loadProfileSummary, type ProfileSummary } from '../lib/userProfiles';
import { validateStringLength } from '../lib/inputGuards';
import { getOrThrow, throwForbidden, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { isSharedInboxReader } from './access';
import {
	MAX_NOTE_COUNT_THREADS,
	NOTE_BODY_MAX_LENGTH,
	NOTE_COUNT_CAP,
	NOTE_THREAD_LIMIT,
	normalizeNoteBody,
	toNoteView,
} from './noteRules';
import { clearNoteMentions, resolveNoteMentions, syncNoteMentions } from './noteMentions';

/** A typed body, cleaned and bounded; empty is refused. */
function acceptBody(raw: string): string {
	const body = normalizeNoteBody(raw);
	if (!body) throwInvalidInput('A note needs some text');
	validateStringLength(body, NOTE_BODY_MAX_LENGTH, 'Note');
	return body;
}

/**
 * Whether `userId` with `role` may delete `note`: its author, or anyone who
 * administers the workspace. The Team Inbox is owner/admin-only today, so in
 * practice every reader may; the rule is spelled out for when it opens up.
 */
export function canDeleteNote(
	note: Pick<Doc<'threadNotes'>, 'authorId'>,
	userId: string,
	role: OrganizationRole | null
): boolean {
	return note.authorId === userId || hasPermission(role, 'organization:manage');
}

/** The author's display name for a mention notice. */
async function authorName(ctx: MutationCtx, userId: string): Promise<string> {
	const profile = await loadProfileSummary(ctx, userId);
	return profile.name?.trim() || profile.email || 'A teammate';
}

/** The thread's subject for the mention notice. */
async function noticeSubject(ctx: MutationCtx, note: Pick<Doc<'threadNotes'>, 'threadId'>) {
	const thread = await ctx.db.get(note.threadId);
	return thread?.subject ?? '';
}

/**
 * A thread's notes, oldest first (the newest {@link NOTE_THREAD_LIMIT}), with
 * their authors resolved. Deleted notes come back as tombstones without text.
 * Soft-auth: `[]` for anyone who cannot read the Team Inbox.
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const listForThread = publicQuery({
	args: { threadId: v.id('conversationThreads') },
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session) || !(await isFeatureEnabled(ctx, 'inbox'))) return [];
		const newestFirst = await ctx.db
			.query('threadNotes')
			.withIndex('by_thread_and_created', (q) => q.eq('threadId', args.threadId))
			.order('desc')
			.take(NOTE_THREAD_LIMIT);
		const authors = new Map<string, ProfileSummary>();
		const views = [];
		for (const note of newestFirst.reverse()) {
			let author = authors.get(note.authorId);
			if (!author) {
				author = await loadProfileSummary(ctx, note.authorId);
				authors.set(note.authorId, author);
			}
			views.push(toNoteView(note, author));
		}
		return views;
	},
});

/**
 * How many live notes each of the given threads has: the note chip on a Team
 * Inbox row. Only threads with at least one note are returned; a count at
 * {@link NOTE_COUNT_CAP} means "that many or more". Asked by the list page for
 * the rows it shows, so writing a note re-runs this and not every thread list.
 * Soft-auth: `[]` for non-readers.
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const countsForThreads = publicQuery({
	args: { threadIds: v.array(v.id('conversationThreads')) },
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session) || !(await isFeatureEnabled(ctx, 'inbox'))) return [];
		const counted = await Promise.all(
			args.threadIds.slice(0, MAX_NOTE_COUNT_THREADS).map(async (threadId) => {
				const live = await ctx.db
					.query('threadNotes')
					.withIndex('by_thread_and_deleted', (q) =>
						q.eq('threadId', threadId).eq('deletedAt', undefined)
					)
					.take(NOTE_COUNT_CAP);
				return { threadId, count: live.length };
			})
		);
		return counted.filter((row) => row.count > 0);
	},
});

/**
 * Write a note on a thread. Mentioned teammates get a mention notice and the
 * thread shows up under their Mentions filter. Returns the new note's id.
 */
export const create = adminMutation({
	args: {
		threadId: v.id('conversationThreads'),
		body: v.string(),
	},
	handler: async (ctx, args, session) => {
		await assertFeatureEnabled(ctx, 'inbox');
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const body = acceptBody(args.body);
		const now = Date.now();
		const mentionedUserIds = await resolveNoteMentions(ctx, body, session.userId);
		const noteId = await ctx.db.insert('threadNotes', {
			threadId: thread._id,
			authorId: session.userId,
			body,
			mentionedUserIds,
			createdAt: now,
		});
		await syncNoteMentions(ctx, { _id: noteId, threadId: thread._id }, [], mentionedUserIds, {
			subject: thread.subject,
			authorName: await authorName(ctx, session.userId),
			now,
		});
		return noteId;
	},
});

/**
 * Change the text of your own note. Someone the edit newly mentions is
 * notified; someone it no longer mentions loses the thread from their
 * Mentions filter.
 */
export const update = adminMutation({
	args: {
		noteId: v.id('threadNotes'),
		body: v.string(),
	},
	handler: async (ctx, args, session) => {
		await assertFeatureEnabled(ctx, 'inbox');
		const note = await getOrThrow(ctx, args.noteId, 'Note');
		if (note.authorId !== session.userId) throwForbidden('Only its author can edit a note');
		if (note.deletedAt !== undefined) throwInvalidState('This note was deleted');
		const body = acceptBody(args.body);
		if (body === note.body) return { success: true };
		const now = Date.now();
		const mentionedUserIds = await resolveNoteMentions(ctx, body, session.userId);
		await ctx.db.patch(note._id, { body, mentionedUserIds, editedAt: now });
		await syncNoteMentions(ctx, note, note.mentionedUserIds, mentionedUserIds, {
			subject: await noticeSubject(ctx, note),
			authorName: await authorName(ctx, session.userId),
			now,
		});
		return { success: true };
	},
});

/**
 * Delete a note: its author, or an admin. The text and mentions are cleared and
 * the row stays as a tombstone so the thread reads "Note deleted" where it was.
 * Deleting a deleted note is a no-op.
 */
export const remove = adminMutation({
	args: { noteId: v.id('threadNotes') },
	handler: async (ctx, args, session) => {
		await assertFeatureEnabled(ctx, 'inbox');
		const note = await getOrThrow(ctx, args.noteId, 'Note');
		requirePermission(
			canDeleteNote(note, session.userId, session.role),
			'Only its author or an admin can delete a note'
		);
		if (note.deletedAt !== undefined) return { success: true };
		await ctx.db.patch(note._id, { body: '', mentionedUserIds: [], deletedAt: Date.now() });
		await clearNoteMentions(ctx, note._id);
		return { success: true };
	},
});
