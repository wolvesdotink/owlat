/**
 * Pure DOM/Selection helpers shared by {@link useRichText} and its markdown
 * shortcut matchers. These are stateless (no editor ref, no reactive state) and
 * safe to import from either the composable or `richTextShortcuts.ts`. They are
 * re-exported from `useRichText` so existing importers keep working.
 */

const BLOCK_TAGS = new Set([
	'p',
	'div',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'blockquote',
	'li',
	'pre',
]);

/**
 * Return the active selection range when its commonAncestor is contained by
 * the supplied editor element. Returns `null` for SSR, no selection, or
 * selection outside the editor.
 */
export function getSelectionInsideEditor(
	editor: HTMLElement | null,
): { sel: Selection; range: Range } | null {
	if (!editor || typeof window === 'undefined') return null;
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	if (!editor.contains(range.commonAncestorContainer)) return null;
	return { sel, range };
}

/**
 * Walk up from `node` (inclusive) toward `editor` (exclusive) and return the
 * first element matching one of `tagNames` (case-insensitive). Returns null
 * if none found before crossing the editor boundary.
 */
export function findAncestor(
	editor: HTMLElement | null,
	node: Node | null,
	tagNames: string | string[],
): HTMLElement | null {
	const tags = (Array.isArray(tagNames) ? tagNames : [tagNames]).map((t) =>
		t.toLowerCase(),
	);
	let current: Node | null = node;
	while (current && current !== editor) {
		if (current.nodeType === Node.ELEMENT_NODE) {
			const el = current as HTMLElement;
			if (tags.includes(el.tagName.toLowerCase())) return el;
		}
		current = current.parentNode;
	}
	return null;
}

export function getNearestBlock(
	editor: HTMLElement | null,
	node: Node | null,
): HTMLElement | null {
	let current: Node | null = node;
	while (current && current !== editor) {
		if (current.nodeType === Node.ELEMENT_NODE) {
			const el = current as HTMLElement;
			if (BLOCK_TAGS.has(el.tagName.toLowerCase())) return el;
		}
		current = current.parentNode;
	}
	return null;
}

export function unwrapElement(el: HTMLElement): void {
	const parent = el.parentNode;
	if (!parent) return;
	while (el.firstChild) parent.insertBefore(el.firstChild, el);
	parent.removeChild(el);
}

export function replaceTagPreservingChildren(
	el: HTMLElement,
	newTag: string,
): HTMLElement {
	const replacement = document.createElement(newTag);
	while (el.firstChild) replacement.appendChild(el.firstChild);
	el.replaceWith(replacement);
	return replacement;
}

export function selectNodeContents(node: Node): void {
	if (typeof window === 'undefined') return;
	const sel = window.getSelection();
	if (!sel) return;
	sel.removeAllRanges();
	const range = document.createRange();
	range.selectNodeContents(node);
	sel.addRange(range);
}
