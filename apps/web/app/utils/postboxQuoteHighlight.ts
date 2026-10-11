/**
 * Mark a cited quote inside a rendered message body (plan §4.2: "scrolls to
 * the message and highlights the quoted words").
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

/** The visible text as one string, with each UTF-16 unit's text node and offset. */
interface Indexed {
	text: string;
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

/** Elements whose text is never rendered. */
const NOT_RENDERED = /^(HEAD|TITLE|SCRIPT|STYLE|TEMPLATE|NOSCRIPT|IFRAME|OBJECT|SVG|MATH)$/;

/**
 * An inline style that hides its element, as the security scan reads it
 * (`agent/steps/security_scan/hiddenStyle.ts`): display:none,
 * visibility:hidden, zero font size or opacity, white or transparent text.
 */
const HIDING_STYLE =
	/display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?(?![.\d])|opacity\s*:\s*0(?:\.0+)?(?![.\d])|(?<![-\w])color\s*:\s*(?:white|transparent|#fff(?:fff)?|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)|rgba\([^)]{0,64},\s*0(?:\.0+)?\s*\))/i;

function hidesItself(el: Element): boolean {
	if (NOT_RENDERED.test(el.tagName.toUpperCase())) return true;
	if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
	if (HIDING_STYLE.test(el.getAttribute('style') ?? '')) return true;
	const view = el.ownerDocument.defaultView;
	if (!view?.getComputedStyle) return false;
	const style = view.getComputedStyle(el);
	return (
		style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
	);
}

/** Whether a text node is visible: no ancestor hides it (memoized per element). */
function visibleIn(cache: Map<Element, boolean>) {
	const isHidden = (el: Element | null): boolean => {
		if (!el) return false;
		const known = cache.get(el);
		if (known !== undefined) return known;
		const hidden = hidesItself(el) || isHidden(el.parentElement);
		cache.set(el, hidden);
		return hidden;
	};
	return (node: Text) => !isHidden(node.parentElement);
}

function indexText(doc: Document): Indexed {
	const isVisible = visibleIn(new Map());
	const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, 4 /* SHOW_TEXT */, {
		acceptNode: (node) => (isVisible(node as Text) ? 1 /* ACCEPT */ : 2 /* REJECT */),
	});
	const parts: string[] = [];
	const at: Indexed['at'] = [];
	let prev: Text | null = null;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		const value = node.nodeValue ?? '';
		if (prev && startsNewLine(prev, node)) {
			// A separator that belongs to no character: mapped onto the end of `prev`.
			parts.push('\n');
			at.push({ node: prev, offset: Math.max(0, (prev.nodeValue ?? '').length - 1) });
		}
		prev = node;
		parts.push(value);
		for (let i = 0; i < value.length; i++) at.push({ node, offset: i });
	}
	return { text: parts.join(''), at };
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

/** Wrap the raw visible-text range `[start, end)` in marks; return the first. */
function wrap(doc: Document, index: Indexed, start: number, end: number): HTMLElement {
	// Per text node: the first and last source offset the range covers.
	const spans = new Map<Text, { from: number; to: number }>();
	for (let i = start; i < end; i++) {
		const { node, offset } = index.at[i]!;
		const span = spans.get(node);
		if (span) span.to = Math.max(span.to, offset);
		else spans.set(node, { from: offset, to: offset });
	}
	let first: HTMLElement | null = null;
	for (const [node, { from, to }] of spans) {
		// Split the text node around the range and move the middle into a mark.
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
	const needle = normalizeForQuote(cited.quote);
	if (!needle) return { status: 'notFound' };
	const index = indexText(doc);
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
	return { status: 'marked', mark: wrap(doc, index, start, end) };
}
