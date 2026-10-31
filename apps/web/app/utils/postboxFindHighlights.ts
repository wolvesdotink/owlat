/**
 * Find in conversation: what counts as a match in a message body, and the
 * marks that show the matches inside its rendered document.
 *
 * One matching policy for both places a body is read: the detached index the
 * reader builds to count matches in messages that are collapsed, quoted away
 * or not on screen (composables/postbox/postboxFindIndex), and the live body
 * iframe that marks them. Both read the VISIBLE text (utils/postboxTextIndex),
 * so the Nth match the index counted is the Nth match the frame marks.
 *
 * Matching is literal and case-insensitive: the query is never a pattern, so
 * `$5.00 (net)` finds exactly that. Both sides go through grounding's quote
 * normalization (NFKC, curly quotes and dashes folded, invisible characters
 * dropped, whitespace collapsed) and then lowercase unit by unit, which keeps
 * every normalized unit mapped back to the raw text and from there to the DOM.
 * Matches do not overlap: `aa` finds two in `aaaa`, as browser find does.
 */

import { normalizeWithMap, type NormalizedText } from '@owlat/shared/quoteNormalize';
import { POSTBOX_QUOTE_DIVIDER_ATTR } from './postboxRenderPipeline';
import { POSTBOX_FIND_MAX_QUERY } from './postboxFindSeed';
import { indexVisibleText, wrapTextRange, type IndexedText } from './postboxTextIndex';

const FIND_ATTR = 'data-owlat-find';
const FIND_ACTIVE_ATTR = 'data-owlat-find-active';
// Inline: the body document is the mail's own, with no stylesheet of ours.
const FIND_STYLE = 'background:#fde68a;color:#1f2937;border-radius:2px';
const FIND_ACTIVE_STYLE =
	'background:#f59e0b;color:#111827;border-radius:2px;outline:2px solid #b45309;outline-offset:0';

/** A withheld remote image's stand-in names no word of the mail. */
const isBlockedImageStandIn = (el: Element) => el.hasAttribute('data-blocked-img');

/** Lowercase each unit where that keeps it one unit, so the offset map holds. */
function foldCase(text: NormalizedText): NormalizedText {
	let folded = '';
	for (const unit of text.normalized) {
		const lower = unit.toLowerCase();
		folded += lower.length === 1 ? lower : unit;
	}
	return { normalized: folded, from: text.from, to: text.to };
}

/** The needle a typed query searches for; empty when there is nothing to find. */
export function postboxFindNeedle(query: string): string {
	return foldCase(normalizeWithMap(query.slice(0, POSTBOX_FIND_MAX_QUERY))).normalized;
}

/** Every start of `needle` in `hay`, left to right, not overlapping. */
export function postboxFindOccurrences(hay: string, needle: string): number[] {
	const out: number[] = [];
	if (!needle) return out;
	for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
		out.push(at);
	}
	return out;
}

/** One message's searchable text: what its body shows, quoted chain included. */
export interface PostboxFindText {
	/** Normalized, case-folded visible text. */
	text: string;
	/** Where the quoted chain starts in `text` (its length when there is none). */
	quotedFrom: number;
}

/** Matches of `needle` in a message, and how many of them sit above its quote. */
export function countPostboxFindMatches(
	entry: PostboxFindText,
	needle: string
): { total: number; fresh: number } {
	const all = postboxFindOccurrences(entry.text, needle);
	// A match that starts in the fresh text but runs into the quote needs the
	// quote shown to be marked whole, so it counts as quoted.
	const fresh = all.filter((at) => at + needle.length <= entry.quotedFrom).length;
	return { total: all.length, fresh };
}

function foldedIndex(doc: Document): { index: IndexedText; hay: NormalizedText } {
	const index = indexVisibleText(doc, { skip: isBlockedImageStandIn });
	return { index, hay: foldCase(normalizeWithMap(index.text)) };
}

/**
 * The searchable text of a rendered body document: the render pipeline's
 * output with the quoted chain shown and its divider marked. The divider
 * itself is invisible text-wise; everything after it is the quote.
 */
export function postboxFindTextOf(doc: Document): PostboxFindText {
	const { index, hay } = foldedIndex(doc);
	const divider = doc.querySelector(`[${POSTBOX_QUOTE_DIVIDER_ATTR}]`);
	if (!divider) return { text: hay.normalized, quotedFrom: hay.normalized.length };
	// The first raw unit whose text node follows the divider starts the quote.
	const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
	let rawQuoteStart = index.at.length;
	for (let i = 0; i < index.at.length; i++) {
		if (divider.compareDocumentPosition(index.at[i]!.node) & FOLLOWING) {
			rawQuoteStart = i;
			break;
		}
	}
	let quotedFrom = hay.normalized.length;
	for (let n = 0; n < hay.from.length; n++) {
		if (hay.from[n]! >= rawQuoteStart) {
			quotedFrom = n;
			break;
		}
	}
	return { text: hay.normalized, quotedFrom };
}

/** Remove every find mark (and only those); the text reads as before. */
export function clearPostboxFindMarks(doc: Document): void {
	const marks = doc.querySelectorAll(`mark[${FIND_ATTR}]`);
	if (marks.length === 0) return;
	for (const mark of marks) mark.replaceWith(...mark.childNodes);
	doc.body?.normalize();
}

/** A stretch of raw visible text that one mark covers. */
interface MarkSegment {
	start: number;
	end: number;
	active: boolean;
}

/**
 * The raw ranges of non-overlapping normalized matches can still overlap: one
 * source unit can expand into several normalized units (`ﬃ` is `ffi`), so two
 * matches of `f` both sit on the same glyph. Cut the raw text at every match
 * edge into segments that are each covered by the same matches throughout,
 * and wrap every covered segment once. `ranges` is in document order with
 * non-decreasing ends (the normalization map is monotonic). Also returns the
 * index of the active match's first segment.
 */
function markSegments(
	ranges: ReadonlyArray<{ start: number; end: number }>,
	active: number | null
): { segments: MarkSegment[]; activeFirst: number | null } {
	const cuts = [...new Set(ranges.flatMap((range) => [range.start, range.end]))].sort(
		(a, b) => a - b
	);
	const segments: MarkSegment[] = [];
	let activeFirst: number | null = null;
	let open = 0;
	for (let c = 0; c + 1 < cuts.length; c++) {
		const start = cuts[c]!;
		while (open < ranges.length && ranges[open]!.end <= start) open++;
		// Every range from `open` that starts by `start` ends at a later cut, so
		// it covers this whole segment.
		let covered = false;
		let isActive = false;
		for (let k = open; k < ranges.length && ranges[k]!.start <= start; k++) {
			covered = true;
			if (k === active) isActive = true;
		}
		if (!covered) continue;
		if (isActive) activeFirst ??= segments.length;
		segments.push({ start, end: cuts[c + 1]!, active: isActive });
	}
	return { segments, activeFirst };
}

/**
 * Mark every match of `needle` in a live body document, the `active`-th one
 * (0-based, in this document) distinctly. Returns how many it marked and the
 * active match's first mark, to scroll to. Matches that share a source glyph
 * share its mark; the count is still one per match.
 */
export function markPostboxFindMatches(
	doc: Document,
	needle: string,
	active: number | null
): { count: number; active: HTMLElement | null } {
	clearPostboxFindMarks(doc);
	if (!needle || !doc.body) return { count: 0, active: null };
	const { index, hay } = foldedIndex(doc);
	const starts = postboxFindOccurrences(hay.normalized, needle);
	const { segments, activeFirst } = markSegments(
		starts.map((at) => ({ start: hay.from[at]!, end: hay.to[at + needle.length - 1]! })),
		active
	);
	let activeMark: HTMLElement | null = null;
	// Last to first: wrapping splits text nodes after the range, never before it.
	for (let k = segments.length - 1; k >= 0; k--) {
		const segment = segments[k]!;
		const mark = wrapTextRange(doc, index, segment.start, segment.end, {
			[FIND_ATTR]: '',
			...(segment.active ? { [FIND_ACTIVE_ATTR]: '' } : {}),
			style: segment.active ? FIND_ACTIVE_STYLE : FIND_STYLE,
		});
		if (k === activeFirst) activeMark = mark;
	}
	return { count: starts.length, active: activeMark };
}
