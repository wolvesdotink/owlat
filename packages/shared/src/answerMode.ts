/**
 * Answer mode: the full-screen reply surface (conversation + composer) shared by
 * the Postbox, the team inbox and the Answer queue.
 *
 * Pure constants and helpers used on both sides of the wire: the backend decides
 * how many rounds of questions the drafter may ask, and the web app detects the
 * gap placeholders a "draft with gaps" leaves behind.
 */

import { escapeHtmlWithBreaks, htmlToPlainText } from './html';

/**
 * The error a "Draft with AI" stream ends with when the draft would need a fact
 * Owlat never asks for (a password, a code): there is no AI draft for that
 * reply, and the web says so the way it does for a message the safety check
 * held back.
 */
export const DRAFT_HELD_FOR_SECRET = 'draft_held_secret';

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
 * Most files one Reply Queue file answer takes ("the invoices for our four
 * bookings" is one question with several files).
 */
export const MAX_FILES_PER_ANSWER = 10;

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

/**
 * The start of a reply body's seeded tail: the signature block
 * (`data-postbox-signature`) or the quoted original (`gmail_quote`), with
 * their `<br><br>` spacing.
 */
const ANSWER_TAIL_START =
	/(?:<br\s*\/?>\s*){0,2}<div[^>]*(?:\bdata-postbox-signature\b|class=["'][^"']*gmail_quote)/i;

/** Split a reply body into what was written and the seeded tail (signature, quote). */
export function splitAnswerBody(bodyHtml: string): { fresh: string; tail: string } {
	const index = bodyHtml.search(ANSWER_TAIL_START);
	if (index < 0) return { fresh: bodyHtml, tail: '' };
	return { fresh: bodyHtml.slice(0, index), tail: bodyHtml.slice(index) };
}

/**
 * Plain AI text as the composer's HTML: blank lines make paragraphs, single
 * line breaks stay breaks, and everything is escaped (model output is never
 * markup). Applying an AI draft writes exactly this in place of the written
 * part, so a body whose written part still equals it holds the AI's text
 * untouched.
 */
export function aiTextToHtml(text: string): string {
	const paragraphs = text
		.replace(/\r\n?/g, '\n')
		.trim()
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	return paragraphs.map((p) => `<p>${escapeHtmlWithBreaks(p)}</p>`).join('');
}

/**
 * Whether the written part of a reply body is still exactly the AI's text
 * (`aiText`, the draft's recorded AI baseline): no word added, removed or
 * changed. Markup the editor re-serialized does not count as an edit; anything
 * a person typed does, including text kept above the AI's.
 */
export function isUntouchedAiAnswer(bodyHtml: string, aiText: string): boolean {
	const expected = htmlToPlainText(aiTextToHtml(aiText));
	return expected.length > 0 && htmlToPlainText(splitAnswerBody(bodyHtml).fresh) === expected;
}
