/**
 * ↑ in an empty message box brings back what you last wrote. In Chat it opens
 * your last message in its inline editor; in the Assistant it puts your last
 * question back in the box, and each further ↑ steps to the one before (↓
 * steps forward again, and past the newest back to an empty box).
 *
 * Pure, so both composers and their callers share one reading of the key and
 * one rule for what counts as "your last message".
 */

import { chordFromEvent, type ChordEventLike } from './shortcutRegistry';

/** Recall: the older entry (Chat: your last message). */
export const COMPOSER_RECALL_OLDER_CHORD = 'ArrowUp';
/** Recall: the newer entry (the Assistant's question history only). */
export const COMPOSER_RECALL_NEWER_CHORD = 'ArrowDown';

export type ComposerRecallDirection = 'older' | 'newer';

/**
 * The direction a press asks for. Only the bare arrow recalls: Shift+↑ selects
 * text, Alt/Cmd/Ctrl+↑ move the caret, and all of them keep doing so.
 */
export function composerRecallDirection(event: ChordEventLike): ComposerRecallDirection | null {
	const chord = chordFromEvent(event);
	if (chord === COMPOSER_RECALL_OLDER_CHORD) return 'older';
	if (chord === COMPOSER_RECALL_NEWER_CHORD) return 'newer';
	return null;
}

type CaretField = Pick<HTMLTextAreaElement, 'value' | 'selectionStart' | 'selectionEnd'>;

/**
 * The caret sits on the field's first line with nothing selected, so ↑ has no
 * line left to move to. A line wrapped by width is not seen here: in a long
 * single-line prompt ↑ recalls rather than moving up a visual row.
 */
export function caretOnFirstLine(field: CaretField): boolean {
	const { selectionStart, selectionEnd, value } = field;
	return selectionStart === selectionEnd && !value.slice(0, selectionStart ?? 0).includes('\n');
}

/** The caret sits on the field's last line with nothing selected. */
export function caretOnLastLine(field: CaretField): boolean {
	const { selectionStart, selectionEnd, value } = field;
	return selectionStart === selectionEnd && !value.slice(selectionEnd ?? 0).includes('\n');
}

// --- Chat: your last message -------------------------------------------------

/** The fields of a chat message row that decide whether ↑ may open it. */
export interface ChatRecallMessage {
	_id: string;
	roomId: string;
	authorId: string;
	text: string;
	deletedAt?: number;
	isAssistant?: boolean;
}

/**
 * What ↑ in an empty chat box does:
 *   - `edit`: open this message's editor;
 *   - `notLoaded`: none of the loaded messages is yours, but older history
 *     exists that may hold one (`canLoadEarlier` is false once the window is
 *     at its cap and "Load earlier messages" is gone);
 *   - `none`: nothing to open, and nothing worth saying.
 */
export type ChatRecallTarget<MessageId extends string = string> =
	| { kind: 'edit'; messageId: MessageId }
	| { kind: 'notLoaded'; canLoadEarlier: boolean }
	| { kind: 'none' };

/**
 * Your newest message that can still be edited: written by you, not deleted,
 * not an assistant reply, with text (the editor never saves an empty message).
 *
 * The list is the room's newest messages, a contiguous run up to the latest,
 * so the newest eligible message in it is the newest in the room. When the run
 * holds none and older history exists, the answer is unknown and says so
 * (`notLoaded`) rather than treating the loaded part as the whole room. A list
 * still loading, or still holding another room's rows after a switch, answers
 * `none`.
 */
export function findChatRecallTarget<M extends ChatRecallMessage>(input: {
	roomId: string | null | undefined;
	userId: string | null | undefined;
	messages: readonly M[];
	/** The list answered for the current window (not loading, not failed). */
	settled: boolean;
	hasMore: boolean;
	canLoadEarlier: boolean;
}): ChatRecallTarget<M['_id']> {
	const { roomId, userId, messages } = input;
	if (!input.settled || !roomId || !userId) return { kind: 'none' };
	if (messages.some((message) => message.roomId !== roomId)) return { kind: 'none' };
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!;
		if (
			message.authorId === userId &&
			!message.deletedAt &&
			message.isAssistant !== true &&
			message.text.trim().length > 0
		) {
			return { kind: 'edit', messageId: message._id };
		}
	}
	return input.hasMore
		? { kind: 'notLoaded', canLoadEarlier: input.canLoadEarlier }
		: { kind: 'none' };
}

// --- Assistant: your earlier questions ---------------------------------------

export interface PromptHistoryEntry {
	id: string;
	prompt: string;
}

/** Where ↑ / ↓ left the box: the entry shown, and the exact text put there. */
export interface PromptHistoryPosition {
	entryId: string;
	recalled: string;
}

/**
 * The questions you asked, oldest first. Assistant turns and blank text are
 * skipped, and the same question asked twice in a row is one entry (the later
 * one), so ↑ never shows the same text twice running.
 */
export function buildPromptHistory(
	messages: readonly { _id: string; role: string; text: string }[]
): PromptHistoryEntry[] {
	const entries: PromptHistoryEntry[] = [];
	for (const message of messages) {
		if (message.role !== 'user') continue;
		const prompt = message.text.trim();
		if (!prompt) continue;
		const previous = entries.at(-1);
		if (previous && previous.prompt === prompt) {
			entries[entries.length - 1] = { id: message._id, prompt };
			continue;
		}
		entries.push({ id: message._id, prompt });
	}
	return entries;
}

/**
 * One step through the history, or null when the key should keep its usual
 * meaning. Stepping only continues from a box that still holds exactly the
 * recalled text: once you edit it, ↑ and ↓ move the caret again, and a box
 * with text you typed yourself is never replaced.
 */
export function stepPromptHistory(input: {
	direction: ComposerRecallDirection;
	entries: readonly PromptHistoryEntry[];
	position: PromptHistoryPosition | null;
	current: string;
}): { position: PromptHistoryPosition | null; prompt: string } | null {
	const { entries, position, current } = input;
	let active = -1;
	if (position && position.recalled === current) {
		active = entries.findIndex((entry) => entry.id === position.entryId);
		if (active < 0) active = entries.findLastIndex((entry) => entry.prompt === position.recalled);
	}

	if (input.direction === 'older') {
		if (active < 0 && current.length > 0) return null;
		const entry = entries[active < 0 ? entries.length - 1 : active - 1];
		if (!entry) return null;
		return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
	}

	if (active < 0) return null;
	const entry = entries[active + 1];
	if (!entry) return { position: null, prompt: '' };
	return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
}
