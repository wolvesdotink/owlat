/**
 * A passage the person selected in a message and chose to quote in their
 * reply: what the passage becomes, the class that marks its block in a reply
 * body, and where a further passage goes in a body that already holds some.
 *
 * The block is a `gmail_quote`, so Answer mode's split (`splitAnswerBody`)
 * counts it as part of the seeded tail, out of reach of an AI draft that
 * replaces what was written, and every mail client folds it as quoted text.
 * Its second class keeps Answer mode from folding it away with the full quoted
 * original: the person asked for this passage, so it stays on screen.
 *
 * Pure string work (no DOM), so it runs the same in tests and in the browser.
 */
import { splitAnswerBody } from '@owlat/shared/answerMode';

/** Marks a selected passage's quote block (next to `gmail_quote`). */
export const SELECTED_QUOTE_CLASS = 'owlat_selected_quote';

/**
 * The selected text as it is quoted: line endings unified, non-breaking spaces
 * made plain, trailing spaces and runs of blank lines dropped, outer
 * whitespace trimmed. Empty when nothing but whitespace was selected.
 */
export function normalizeQuotedPassage(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.replace(/ /g, ' ')
		.split('\n')
		.map((line) => line.replace(/[ \t]+$/, ''))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** A selected-quote block opening at the start of the string (after spacing). */
const LEADING_SELECTED_QUOTE = new RegExp(
	`^(?:\\s|<br\\s*/?>)*<div\\b[^>]*\\bclass=["'][^"']*\\b${SELECTED_QUOTE_CLASS}\\b[^"']*["'][^>]*>`,
	'i'
);

/** Offset just past the selected-quote block starting at `from`, or null. */
function selectedQuoteBlockEnd(html: string, from: number): number | null {
	const rest = html.slice(from);
	const open = LEADING_SELECTED_QUOTE.exec(rest);
	if (!open) return null;
	const tags = /<(\/?)div\b[^>]*>/gi;
	tags.lastIndex = open[0].length;
	let depth = 1;
	for (let tag = tags.exec(rest); tag; tag = tags.exec(rest)) {
		depth += tag[1] ? -1 : 1;
		if (depth === 0) return from + tag.index + tag[0].length;
	}
	// Unbalanced markup: not a block this can step over.
	return null;
}

/**
 * `bodyHtml` with the selected-quote block `blockHtml` added after the passages
 * already quoted this way, else where the written part ends (before the
 * signature and the quoted original), so several passages read in the order
 * they were picked. What was written, the signature and the original stay as
 * they were.
 */
export function insertSelectedQuote(bodyHtml: string, blockHtml: string): string {
	const { fresh, tail } = splitAnswerBody(bodyHtml);
	let at = 0;
	for (
		let end = selectedQuoteBlockEnd(tail, at);
		end !== null;
		end = selectedQuoteBlockEnd(tail, at)
	) {
		at = end;
	}
	return `${fresh}${tail.slice(0, at)}${blockHtml}${tail.slice(at)}`;
}
