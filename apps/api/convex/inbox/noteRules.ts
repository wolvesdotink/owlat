/**
 * Internal notes on Team Inbox threads: the pure rules.
 *
 * What a note body may be, who an `@handle` in it reaches, and how a note looks
 * to a reader. No database access here, so `__tests__/noteRules.test.ts`
 * exercises every rule directly; `notes.ts` (the functions) and
 * `noteMentions.ts` (the mention rows and the Mentions filter) apply them.
 */

import { parseMentionHandles } from '@owlat/shared/chatMentions';
import type { Doc } from '../_generated/dataModel';

/** Longest note body, in UTF-16 code units. The composer counts down to it too. */
export const NOTE_BODY_MAX_LENGTH = 5_000;

/** Most people one note can notify; further handles stay plain text. */
export const MAX_NOTE_MENTIONS = 20;

/** Newest notes one thread view shows. */
export const NOTE_THREAD_LIMIT = 200;

/** A thread's count chip reads at most this many notes ("99+" past it). */
export const NOTE_COUNT_CAP = 100;

/** Most threads one `countsForThreads` call answers for (the list pages 25). */
export const MAX_NOTE_COUNT_THREADS = 200;

/** Newest mention rows the Mentions filter reads. */
export const MENTION_SCAN_LIMIT = 200;

/**
 * Clean a typed body: Windows line ends become `\n`, control characters other
 * than newline and tab go, and surrounding whitespace is trimmed. A note is
 * plain text and renders through text interpolation, so there is no markup to
 * sanitize; this only keeps invisible bytes out of the stored text.
 */
export function normalizeNoteBody(raw: string): string {
	return (
		raw
			.replace(/\r\n?/g, '\n')
			// eslint-disable-next-line no-control-regex -- stripping control characters is the point
			.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
			.trim()
	);
}

/** Someone a note may mention: a Team Inbox reader and their profile. */
export interface MentionCandidate {
	userId: string;
	email: string | null;
	name: string | null;
}

/**
 * The handles a candidate answers to, the same two chat resolves
 * (`chat/mentions.ts resolveMentionsToMemberIds`): the email local-part and the
 * profile name with spaces turned into dots, both lowercased.
 */
export function candidateHandles(candidate: MentionCandidate): string[] {
	const handles: string[] = [];
	const local = (candidate.email ?? '').split('@')[0]?.toLowerCase() ?? '';
	if (local) handles.push(local);
	const slug = (candidate.name ?? '').trim().toLowerCase().replace(/\s+/g, '.');
	if (slug) handles.push(slug);
	return handles;
}

/**
 * The people `body` mentions, as user ids, in the order their handles first
 * appear. Only `candidates` can be reached (the caller passes Team Inbox
 * readers, so nobody without access is ever notified), the author never
 * mentions themself, punctuation closing a sentence after a handle is not part
 * of it, and at most {@link MAX_NOTE_MENTIONS} are returned.
 */
export function resolveMentionedUserIds(
	body: string,
	candidates: readonly MentionCandidate[],
	authorId: string
): string[] {
	const byHandle = new Map<string, string[]>();
	for (const candidate of candidates) {
		if (candidate.userId === authorId) continue;
		for (const handle of candidateHandles(candidate)) {
			const ids = byHandle.get(handle) ?? [];
			if (!ids.includes(candidate.userId)) ids.push(candidate.userId);
			byHandle.set(handle, ids);
		}
	}
	const resolved: string[] = [];
	for (const handle of parseMentionHandles(body)) {
		// The handle grammar takes `.`, `-` and `_`, so "Thanks @ben." reads as
		// `ben.`; a handle that names nobody is retried without that tail.
		const ids = byHandle.get(handle) ?? byHandle.get(handle.replace(/[.\-_]+$/, '')) ?? [];
		for (const userId of ids) {
			if (!resolved.includes(userId)) resolved.push(userId);
		}
	}
	return resolved.slice(0, MAX_NOTE_MENTIONS);
}

/** Who an edit newly mentions and who it no longer does. */
export function diffMentions(
	previous: readonly string[],
	next: readonly string[]
): { added: string[]; removed: string[] } {
	return {
		added: next.filter((id) => !previous.includes(id)),
		removed: previous.filter((id) => !next.includes(id)),
	};
}

/** The author as a reader sees them. */
export interface NoteAuthor {
	name: string | null;
	email: string | null;
	image: string | null;
}

/**
 * One note as the thread view receives it. A deleted note keeps its place and
 * time and carries no text (`isDeleted`), so it reads "Note deleted".
 */
export function toNoteView(note: Doc<'threadNotes'>, author: NoteAuthor) {
	const isDeleted = note.deletedAt !== undefined;
	return {
		_id: note._id,
		threadId: note.threadId,
		authorId: note.authorId,
		authorName: author.name,
		authorEmail: author.email,
		authorImage: author.image,
		body: isDeleted ? '' : note.body,
		mentionedUserIds: isDeleted ? [] : note.mentionedUserIds,
		createdAt: note.createdAt,
		editedAt: note.editedAt ?? null,
		isDeleted,
	};
}

export type NoteView = ReturnType<typeof toNoteView>;
