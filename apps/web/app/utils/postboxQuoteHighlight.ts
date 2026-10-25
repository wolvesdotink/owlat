/**
 * Mark a cited quote inside a rendered message body (scroll to
 * the message and highlight the quoted words).
 *
 * The evidence offsets index the interpretation's canonical text
 * (`@owlat/shared/mailSegments`); the body the reader renders has been
 * sanitized, link-rewritten and dark-adapted since, so no offset survives
 * into its DOM. What does survive is WHICH occurrence of the words it was:
 * grounding stamps every evidence span with `occurrence` (the Nth match of the
 * normalized quote in the canonical, scanner-stripped text) and
 * `occurrenceCount` (how many matches that text holds; `mail/interpret/
 * quoteMatch.ts quoteOccurrences`). This counts the same normalized words in
 * the VISIBLE rendered text only (hidden attributes, aria-hidden, display:none,
 * visibility:hidden, zero size or opacity, white or transparent text, and
 * non-rendered elements are skipped, as the scanner strips them), and marks the
 * Nth match only when it sees exactly `occurrenceCount` of them.
 *
 * It never guesses: when the counts differ, or the evidence predates the
 * counts and the words appear more than once, nothing is marked and the result
 * says why, so the reader can say it could not locate the exact passage.
 *
 * Normalization is grounding's own (`@owlat/shared/quoteNormalize`): NFKC over
 * complete combining sequences, curly quotes and dashes folded to ASCII,
 * invisible format characters dropped, whitespace runs collapsed, case kept.
 * It runs over the whole visible text, and its offset map leads a normalized
 * match back to the raw text, then to the DOM text nodes.
 *
 * Pure DOM work over a `Document`: the body iframe is same-origin, and a test
 * hands in any document.
 */

import { normalizeForQuote, normalizeWithMap } from '@owlat/shared/quoteNormalize';
import { indexVisibleText, wrapTextRange } from './postboxTextIndex';

const MARK_ATTR = 'data-owlat-cite';
const MARK_STYLE = 'background:#f6dfb4;color:inherit;border-radius:2px;padding:0 1px';

/** A cited quote: its words and which occurrence of them it is (0 = the first). */
export interface CitedQuote {
	quote: string;
	occurrence?: number;
	/** Matches of the words in the interpreted (visible) text. */
	occurrenceCount?: number;
}

export type HighlightResult =
	| { status: 'marked'; mark: HTMLElement }
	/** The words are not there, or not that many times. */
	| { status: 'notFound' }
	/** The words appear more than once and the evidence does not say which. */
	| { status: 'ambiguous' };

/** Remove marks a previous cite left behind. */
export function clearQuoteHighlight(doc: Document): void {
	for (const mark of doc.querySelectorAll(`mark[${MARK_ATTR}]`)) {
		mark.replaceWith(...mark.childNodes);
	}
	doc.body?.normalize();
}

/** Every start index of `needle` in `hay`. */
function matchesOf(hay: string, needle: string): number[] {
	const out: number[] = [];
	for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) out.push(at);
	return out;
}

/** Mark the cited occurrence of the quote, or say why not (see the module note). */
export function highlightQuote(doc: Document, cited: CitedQuote): HighlightResult {
	clearQuoteHighlight(doc);
	const needle = normalizeForQuote(cited.quote);
	if (!needle) return { status: 'notFound' };
	const index = indexVisibleText(doc);
	// Grounding's normalization over the whole visible text, with its map back
	// to raw offsets: combining sequences normalize exactly as they did there.
	const hay = normalizeWithMap(index.text);
	const matches = matchesOf(hay.normalized, needle);
	let at: number | undefined;
	if (cited.occurrence !== undefined && cited.occurrenceCount !== undefined) {
		// The visible text must hold exactly the matches grounding counted.
		if (matches.length !== cited.occurrenceCount) return { status: 'notFound' };
		at = matches[cited.occurrence];
	} else if (matches.length > 1) {
		return { status: 'ambiguous' };
	} else {
		at = matches[0];
	}
	if (at === undefined) return { status: 'notFound' };
	const start = hay.from[at]!;
	const end = hay.to[at + needle.length - 1]!;
	return {
		status: 'marked',
		mark: wrapTextRange(doc, index, start, end, { [MARK_ATTR]: '', style: MARK_STYLE }),
	};
}
