/**
 * Answer mode: the full-screen reply surface (conversation + composer) shared by
 * the Postbox, the team inbox and the Answer queue.
 *
 * Pure constants and helpers used on both sides of the wire: the backend decides
 * when a thread earns a catch-up summary and how many rounds of questions the
 * drafter may ask, and the web app renders the same thresholds and detects the
 * gap placeholders a "draft with gaps" leaves behind.
 */

/** A thread with at least this many messages gets a catch-up summary. */
export const CATCH_UP_MIN_MESSAGES = 3;
/** ...or a newest message at least this long (characters of plain text). */
export const CATCH_UP_MIN_CHARS = 1500;
/** A short thread still shows its asks checklist when it has this many asks. */
export const CATCH_UP_MIN_ASKS_FOR_CHECKLIST = 2;

/** Whether a thread is long enough to be worth a catch-up summary. */
export function isCatchUpWorthy(messageCount: number, newestMessageChars: number): boolean {
	return messageCount >= CATCH_UP_MIN_MESSAGES || newestMessageChars >= CATCH_UP_MIN_CHARS;
}

/** Questions per round before drafting, and rounds per draft. */
export const MAX_ASK_QUESTIONS = 3;
export const MAX_ASK_ROUNDS = 2;

/** How an ask-before-draft question is answered. Every kind also accepts free text. */
export const ASK_ANSWER_KINDS = ['choice', 'text', 'date', 'number', 'file'] as const;
export type AskAnswerKind = (typeof ASK_ANSWER_KINDS)[number];

/** Where a file answer's bytes live. */
export const ASK_FILE_SOURCES = ['upload', 'semanticFile', 'mailAttachment'] as const;
export type AskFileSource = (typeof ASK_FILE_SOURCES)[number];

/**
 * Gap placeholders. When the person skips a question, the drafter writes
 * `[[attach the September invoice]]` where the missing fact goes. Send stays
 * blocked while any placeholder remains. Double brackets are rare in real mail,
 * and the label inside is plain text without brackets or line breaks.
 */
const GAP_PATTERN = /\[\[([^[\]\n]{1,160})\]\]/g;

export interface DraftGap {
	/** Offset of the opening `[[`. */
	start: number;
	/** Offset just past the closing `]]`. */
	end: number;
	/** The text between the brackets, trimmed. */
	label: string;
}

/** Every gap placeholder in `text`, in order. */
export function findDraftGaps(text: string): DraftGap[] {
	const gaps: DraftGap[] = [];
	for (const match of text.matchAll(GAP_PATTERN)) {
		const label = (match[1] ?? '').trim();
		if (!label) continue;
		gaps.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, label });
	}
	return gaps;
}

/** Whether `text` still holds a gap placeholder. */
export function hasDraftGaps(text: string): boolean {
	return findDraftGaps(text).length > 0;
}

/** The placeholder for a missing fact, as the drafter writes it. */
export function formatDraftGap(label: string): string {
	return `[[${label
		.replace(/[[\]\n]/g, ' ')
		.trim()
		.slice(0, 160)}]]`;
}
