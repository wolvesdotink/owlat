/**
 * Internal notes and the thread brief (SPEC §2, §7 "Team"): a note's `#` link
 * to an item, and emoji reactions on notes.
 *
 * Notes live in two tables: Team Inbox `threadNotes` (`inbox/notes.ts`) and
 * the Postbox thread discussion's `chatMessages` (`chat/mailDiscussion.ts`).
 * Both carry an optional `threadItemId`, which must name an item of the SAME
 * thread ({@link requireSameThreadItem}). Chat has no reaction mechanism of
 * its own, so both kinds of note share `noteReactions`: one row per (note,
 * person, emoji), toggled here and bounded per note.
 *
 * Authorization stays with the callers (the note's own surface decides who
 * may write it); this module only stores. Notes never reach interpretation
 * or a model prompt, and neither does anything here.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { throwInvalidInput } from '../../_utils/errors';
import {
	rowMatchesThreadRef,
	threadRefToFields,
	type ThreadRef,
} from '../../lib/validators/threadRef';
import type { NoteSource } from '../../lib/validators/threadBrief';

/** Distinct emojis one note can carry. */
export const MAX_NOTE_REACTION_EMOJIS = 20;
/** Emojis one person can put on one note. */
export const MAX_NOTE_REACTIONS_PER_PERSON = 10;
/** Reaction rows one note can hold (and a read scans at most). */
export const MAX_NOTE_REACTION_ROWS = 500;
/** Longest emoji (a ZWJ family with skin tones runs to about a dozen code units). */
const MAX_EMOJI_LENGTH = 32;

/**
 * Pictographs, flags and their joiners, variation selectors, skin tones and
 * tag sequences: what an emoji picker produces. No letters, digits or spaces.
 */
const EMOJI_RE =
	/^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u200d|\ufe0f|\u20e3|[\u{E0020}-\u{E007F}])+$/u;

/** The note a reaction belongs to. */
export type NoteRef =
	| { source: 'threadNote'; id: Id<'threadNotes'> }
	| { source: 'chatMessage'; id: Id<'chatMessages'> };

/** One emoji on a note, as a reader sees it. */
export interface NoteReactionView {
	emoji: string;
	count: number;
	isMine: boolean;
}

/** A typed emoji, trimmed; anything that is not one is refused. Pure. */
export function acceptReactionEmoji(raw: string): string {
	const emoji = raw.trim();
	if (!emoji || emoji.length > MAX_EMOJI_LENGTH || !EMOJI_RE.test(emoji)) {
		throwInvalidInput('React with an emoji');
	}
	return emoji;
}

/**
 * The item a note links to, checked against the note's thread: undefined for
 * no link, the id when the item exists and belongs to `ref`; otherwise
 * `invalid_input` (an item of another thread, or one that is gone).
 */
export async function requireSameThreadItem(
	ctx: Pick<MutationCtx, 'db'>,
	threadItemId: Id<'threadItems'> | undefined,
	ref: ThreadRef
): Promise<Id<'threadItems'> | undefined> {
	if (threadItemId === undefined) return undefined;
	const item = await ctx.db.get(threadItemId);
	if (!item || !rowMatchesThreadRef(item, ref)) {
		throwInvalidInput('That item is not part of this thread');
	}
	return item._id;
}

function rowsOf(ctx: Pick<QueryCtx, 'db'>, note: NoteRef, userId?: string) {
	if (note.source === 'threadNote') {
		return ctx.db
			.query('noteReactions')
			.withIndex('by_thread_note', (q) =>
				userId === undefined
					? q.eq('threadNoteId', note.id)
					: q.eq('threadNoteId', note.id).eq('userId', userId)
			);
	}
	return ctx.db
		.query('noteReactions')
		.withIndex('by_chat_message', (q) =>
			userId === undefined
				? q.eq('chatMessageId', note.id)
				: q.eq('chatMessageId', note.id).eq('userId', userId)
		);
}

function noteColumns(note: NoteRef): {
	noteSource: NoteSource;
	threadNoteId?: Id<'threadNotes'>;
	chatMessageId?: Id<'chatMessages'>;
} {
	return note.source === 'threadNote'
		? { noteSource: 'threadNote', threadNoteId: note.id }
		: { noteSource: 'chatMessage', chatMessageId: note.id };
}

/**
 * Add `emoji` from `userId` to the note, or take it back when it is already
 * there. Returns whether the reaction is on afterwards. Refuses past the
 * per-note and per-person bounds.
 */
export async function toggleNoteReaction(
	ctx: MutationCtx,
	args: { note: NoteRef; threadRef: ThreadRef; userId: string; emoji: string }
): Promise<{ isOn: boolean }> {
	const emoji = acceptReactionEmoji(args.emoji);
	const mine = await rowsOf(ctx, args.note, args.userId).take(MAX_NOTE_REACTION_ROWS);
	const existing = mine.find((row) => row.emoji === emoji);
	if (existing) {
		await ctx.db.delete(existing._id);
		return { isOn: false };
	}
	if (mine.length >= MAX_NOTE_REACTIONS_PER_PERSON) {
		throwInvalidInput('You reacted to this note enough');
	}
	const all = await rowsOf(ctx, args.note).take(MAX_NOTE_REACTION_ROWS);
	const emojis = new Set(all.map((row) => row.emoji));
	if (
		all.length >= MAX_NOTE_REACTION_ROWS ||
		(!emojis.has(emoji) && emojis.size >= MAX_NOTE_REACTION_EMOJIS)
	) {
		throwInvalidInput('This note has too many reactions');
	}
	await ctx.db.insert('noteReactions', {
		...threadRefToFields(args.threadRef),
		...noteColumns(args.note),
		userId: args.userId,
		emoji,
		createdAt: Date.now(),
	});
	return { isOn: true };
}

/** Fold reaction rows into the reader's view: per emoji, in first-reaction order. Pure. */
export function summarizeNoteReactions(
	rows: ReadonlyArray<Pick<Doc<'noteReactions'>, 'emoji' | 'userId' | 'createdAt'>>,
	viewerId: string
): NoteReactionView[] {
	const byEmoji = new Map<string, NoteReactionView & { first: number }>();
	for (const row of rows) {
		const entry = byEmoji.get(row.emoji) ?? {
			emoji: row.emoji,
			count: 0,
			isMine: false,
			first: row.createdAt,
		};
		entry.count += 1;
		entry.isMine ||= row.userId === viewerId;
		entry.first = Math.min(entry.first, row.createdAt);
		byEmoji.set(row.emoji, entry);
	}
	return [...byEmoji.values()]
		.sort((a, b) => a.first - b.first || a.emoji.localeCompare(b.emoji))
		.map(({ emoji, count, isMine }) => ({ emoji, count, isMine }));
}

/** A note's reactions as `viewerId` sees them. */
export async function readNoteReactions(
	ctx: Pick<QueryCtx, 'db'>,
	note: NoteRef,
	viewerId: string
): Promise<NoteReactionView[]> {
	return summarizeNoteReactions(await rowsOf(ctx, note).take(MAX_NOTE_REACTION_ROWS), viewerId);
}

/** Drop every reaction of a note (the note was deleted). */
export async function clearNoteReactions(ctx: MutationCtx, note: NoteRef): Promise<void> {
	for (const row of await rowsOf(ctx, note).take(MAX_NOTE_REACTION_ROWS)) {
		await ctx.db.delete(row._id);
	}
}
