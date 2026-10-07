/**
 * Mark a cited quote inside a rendered message body (plan §4.2: "scrolls to
 * the message and highlights the quoted words").
 *
 * The quote is matched against the document's visible text, not by offsets:
 * the evidence offsets index the interpretation's canonical text
 * (`@owlat/shared/mailSegments`), and the body the reader renders has been
 * sanitized, link-rewritten and dark-adapted since, so no offset survives
 * into its DOM. Matching normalizes both sides the way grounding does (NFKC,
 * whitespace collapsed, typographic quotes and dashes folded), first
 * case-sensitively, then without case.
 *
 * Pure DOM work over a `Document`: the body iframe is same-origin, and a
 * test hands in any document.
 */

const MARK_ATTR = 'data-owlat-cite';
const MARK_STYLE = 'background:#f6dfb4;color:inherit;border-radius:2px;padding:0 1px';

function fold(ch: string): string {
	if (/\s/.test(ch)) return ' ';
	if (/[‘’‚′]/.test(ch)) return "'";
	if (/[“”„″]/.test(ch)) return '"';
	if (/[‐-―−]/.test(ch)) return '-';
	return ch.normalize('NFKC');
}

/** Normalize a quote the way the document text is normalized below. */
export function normalizeQuote(text: string): string {
	return [...text].map(fold).join('').replace(/ +/g, ' ').trim();
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

/**
 * Wrap the first occurrence of `quote` in `<mark>` elements (one per text node
 * it spans) and return the first mark, or null when the quote is not found.
 */
export function highlightQuote(doc: Document, quote: string): HTMLElement | null {
	clearQuoteHighlight(doc);
	const needle = normalizeQuote(quote);
	if (!needle) return null;
	const index = indexText(doc);
	let start = index.text.indexOf(needle);
	if (start < 0) start = index.text.toLowerCase().indexOf(needle.toLowerCase());
	if (start < 0) return null;
	const end = start + needle.length - 1;

	// Per text node: the first and last source offset the match covers.
	const spans = new Map<Text, { from: number; to: number }>();
	for (let i = start; i <= end; i++) {
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
	return first;
}
