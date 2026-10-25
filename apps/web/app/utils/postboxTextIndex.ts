/**
 * The visible text of a rendered message body, indexed back to its DOM text
 * nodes, and the one way a range of it is wrapped in marks. Shared by the
 * brief's cite marker (utils/postboxQuoteHighlight) and find in conversation
 * (utils/postboxFindHighlights), so both read the same words out of a body.
 *
 * Visible means what the security scan counts as rendered: hidden attributes,
 * aria-hidden, display:none, visibility:hidden, zero size or opacity, white or
 * transparent text and non-rendered elements are skipped. Text in two blocks,
 * or across a `<br>`, is separated by a newline that belongs to no character.
 *
 * Pure DOM work over a `Document`: the body iframe is same-origin, a detached
 * `DOMParser` document works the same, and a test hands in any document.
 */

/** The visible text as one string, with each UTF-16 unit's text node and offset. */
export interface IndexedText {
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
function visibleIn(cache: Map<Element, boolean>, skip: ((el: Element) => boolean) | undefined) {
	const isHidden = (el: Element | null): boolean => {
		if (!el) return false;
		const known = cache.get(el);
		if (known !== undefined) return known;
		const hidden = hidesItself(el) || !!skip?.(el) || isHidden(el.parentElement);
		cache.set(el, hidden);
		return hidden;
	};
	return (node: Text) => !isHidden(node.parentElement);
}

/**
 * Index the visible text of `doc`. `skip` leaves out elements the caller does
 * not count as the mail's words (and everything inside them).
 */
export function indexVisibleText(
	doc: Document,
	options: { skip?: (el: Element) => boolean } = {}
): IndexedText {
	const isVisible = visibleIn(new Map(), options.skip);
	const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, 4 /* SHOW_TEXT */, {
		acceptNode: (node) => (isVisible(node as Text) ? 1 /* ACCEPT */ : 2 /* REJECT */),
	});
	const parts: string[] = [];
	const at: IndexedText['at'] = [];
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

/**
 * Wrap the raw visible-text range `[start, end)` in `<mark>`s carrying `attrs`
 * (one per text node it touches); return the first. Splits text nodes, so an
 * index stays valid only for ranges BEFORE this one: wrap several ranges of one
 * index last to first.
 */
export function wrapTextRange(
	doc: Document,
	index: IndexedText,
	start: number,
	end: number,
	attrs: Readonly<Record<string, string>>
): HTMLElement {
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
		for (const [name, value] of Object.entries(attrs)) mark.setAttribute(name, value);
		middle.parentNode?.insertBefore(mark, middle);
		mark.appendChild(middle);
		first ??= mark;
	}
	return first!;
}
