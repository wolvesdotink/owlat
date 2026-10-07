/**
 * Mark a cited quote inside a rendered message body (plan §4.2: "scrolls to
 * the message and highlights the quoted words").
 *
 * The evidence offsets index the interpretation's canonical text
 * (`@owlat/shared/mailSegments`); the body the reader renders has been
 * sanitized, link-rewritten and dark-adapted since, so no offset survives
 * into its DOM. What does survive is WHICH occurrence of the words it was:
 * grounding stamps every evidence span with `occurrence` (the Nth match of the
 * normalized quote in the canonical text, `mail/interpret/quoteMatch.ts
 * quoteOccurrence`). This marks that Nth match of the same normalized words in
 * the rendered text, so repeated wording never highlights the wrong statement.
 *
 * It never guesses: when the rendered text holds fewer matches than the
 * occurrence, or the occurrence is unknown (evidence stored before it existed)
 * and the words appear more than once, nothing is marked and the result says
 * why, so the reader can say it could not locate the exact passage.
 *
 * Normalization is grounding's (`quoteMatch.ts normalizeForQuote`): NFKC,
 * curly quotes and dashes folded to ASCII, invisible format characters
 * dropped, whitespace runs collapsed. Case must match.
 *
 * Pure DOM work over a `Document`: the body iframe is same-origin, and a test
 * hands in any document.
 */

const MARK_ATTR = 'data-owlat-cite';
const MARK_STYLE = 'background:#f6dfb4;color:inherit;border-radius:2px;padding:0 1px';

/** A cited quote: its words and which occurrence of them it is (0 = the first). */
export interface CitedQuote {
	quote: string;
	occurrence?: number;
}

export type HighlightResult =
	| { status: 'marked'; mark: HTMLElement }
	/** The words are not there, or not that many times. */
	| { status: 'notFound' }
	/** The words appear more than once and the evidence does not say which. */
	| { status: 'ambiguous' };

const SINGLE_QUOTES = /[‘’‚‛′´`]/g;
const DOUBLE_QUOTES = /[“”„‟″«»]/g;
const DASHES = /[‐-―−﹘﹣－]/g;
const INVISIBLE = /[­​-‍⁠﻿]/g;

function fold(ch: string): string {
	if (/\s/.test(ch)) return ' ';
	return ch
		.normalize('NFKC')
		.replace(INVISIBLE, '')
		.replace(SINGLE_QUOTES, "'")
		.replace(DOUBLE_QUOTES, '"')
		.replace(DASHES, '-');
}

/** Normalize a quote the way the document text is normalized below. */
export function normalizeQuote(text: string): string {
	return [...text].map(fold).join('').replace(/\s+/g, ' ').trim();
}

interface Indexed {
	text: string;
	/** For each character of `text`: the text node and offset it came from. */
	at: Array<{ node: Text; offset: number }>;
}

const BLOCK =
	/^(ADDRESS|ARTICLE|BLOCKQUOTE|BODY|DD|DIV|DL|DT|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|OL|P|PRE|SECTION|TABLE|TBODY|TD|TH|TR|UL)$/;

function blockOf(node: Node): Node | null {
	let el = node.parentNode;
	while (el && !(el.nodeType === 1 && BLOCK.test((el as Element).tagName))) el = el.parentNode;
	return el;
}

/** Text in two blocks, or across a `<br>`, reads as two words, not one. */
function startsNewLine(prev: Text | null, node: Text): boolean {
	if (!prev) return false;
	if (blockOf(prev) !== blockOf(node)) return true;
	const before = node.previousSibling;
	return before?.nodeType === 1 && (before as Element).tagName === 'BR';
}

function indexText(doc: Document): Indexed {
	const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, 4 /* SHOW_TEXT */);
	const out: Indexed = { text: '', at: [] };
	let lastSpace = true;
	let prev: Text | null = null;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		const value = node.nodeValue ?? '';
		if (prev && !lastSpace && startsNewLine(prev, node)) {
			// A separator that belongs to no character: mapped onto the end of `prev`.
			out.text += ' ';
			out.at.push({ node: prev, offset: Math.max(0, (prev.nodeValue ?? '').length - 1) });
			lastSpace = true;
		}
		prev = node;
		for (let i = 0; i < value.length; i++) {
			const ch = fold(value[i]!);
			if (ch === ' ' && lastSpace) continue;
			lastSpace = ch === ' ';
			for (const c of ch) {
				out.text += c;
				out.at.push({ node, offset: i });
			}
		}
	}
	return out;
}

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

/** Wrap `[start, start + length)` of the indexed text in marks; return the first. */
function wrap(doc: Document, index: Indexed, start: number, length: number): HTMLElement {
	// Per text node: the first and last source offset the match covers.
	const spans = new Map<Text, { from: number; to: number }>();
	for (let i = start; i < start + length; i++) {
		const { node, offset } = index.at[i]!;
		const span = spans.get(node);
		if (span) span.to = offset;
		else spans.set(node, { from: offset, to: offset });
	}
	let first: HTMLElement | null = null;
	for (const [node, { from, to }] of spans) {
		// Split the text node around the match and move the middle into a mark.
		const middle = node.splitText(from);
		middle.splitText(to + 1 - from);
		const mark = doc.createElement('mark');
		mark.setAttribute(MARK_ATTR, '');
		mark.setAttribute('style', MARK_STYLE);
		middle.parentNode?.insertBefore(mark, middle);
		mark.appendChild(middle);
		first ??= mark;
	}
	return first!;
}

/** Mark the cited occurrence of the quote, or say why not (see the module note). */
export function highlightQuote(doc: Document, cited: CitedQuote): HighlightResult {
	clearQuoteHighlight(doc);
	const needle = normalizeQuote(cited.quote);
	if (!needle) return { status: 'notFound' };
	const index = indexText(doc);
	const matches = matchesOf(index.text, needle);
	let start: number | undefined;
	if (cited.occurrence !== undefined) start = matches[cited.occurrence];
	else if (matches.length > 1) return { status: 'ambiguous' };
	else start = matches[0];
	if (start === undefined) return { status: 'notFound' };
	return { status: 'marked', mark: wrap(doc, index, start, needle.length) };
}
