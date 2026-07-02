/**
 * Rich-text editing primitives for `contenteditable` editors.
 *
 * Shared by:
 *   - `apps/web/app/components/postbox/PostboxBasicEditor.vue` (full webmail composer)
 *   - `packages/email-builder/src/components/canvas/InlineTextEditor.vue`
 *     (campaign builder inline text block)
 *
 * The composable returns DOM-mutating helpers bound to a caller-supplied
 * editor element ref. Format toggles (bold/italic/underline/heading/list/
 * blockquote/link) operate on the current Selection/Range and re-emit the
 * editor's HTML through the supplied `onChange` callback.
 *
 * Selection-aware helpers are guarded against missing window (SSR) and
 * out-of-editor selections — they no-op rather than throwing.
 */

import type { Ref } from 'vue';

export interface ActiveMarks {
	bold: boolean;
	italic: boolean;
	underline: boolean;
	h1: boolean;
	h2: boolean;
	ul: boolean;
	ol: boolean;
	quote: boolean;
	link: boolean;
}

export const EMPTY_ACTIVE_MARKS: Readonly<ActiveMarks> = Object.freeze({
	bold: false,
	italic: false,
	underline: false,
	h1: false,
	h2: false,
	ul: false,
	ol: false,
	quote: false,
	link: false,
});

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

export interface UseRichTextOptions {
	/** Ref to the contenteditable host element. */
	editorRef: Ref<HTMLElement | null>;
	/**
	 * Called after every DOM mutation so the host can re-emit `innerHTML` to
	 * its parent (e.g. via `update:modelValue`).
	 */
	onChange?: () => void;
	/**
	 * Resolve the URL for the link command. Defaults to `window.prompt` —
	 * supply a custom resolver to use a non-blocking modal instead.
	 * Return `null` to cancel; return `''` to remove an existing link.
	 */
	promptForLink?: (currentHref: string | null) => Promise<string | null> | string | null;
}

/**
 * Returns format-toggle helpers and an `activeMarks` syncer bound to the
 * editor element ref. The composable does not mount any DOM listeners — the
 * caller wires `onKeydown`/`onPaste`/etc. on its template element.
 */
export function useRichText(options: UseRichTextOptions) {
	const { editorRef, onChange, promptForLink } = options;

	function notify() {
		onChange?.();
	}

	function getCtx() {
		return getSelectionInsideEditor(editorRef.value);
	}

	function toggleInlineMark(tagAliases: string[]): void {
		const ctx = getCtx();
		if (!ctx) return;
		const { sel, range } = ctx;

		const existing = findAncestor(
			editorRef.value,
			range.commonAncestorContainer,
			tagAliases,
		);
		if (existing) {
			// Acceptable trade-off: removes formatting from the entire ancestor
			// span rather than only the selected sub-range. Matches user intent
			// for the common single-block case.
			unwrapElement(existing);
			notify();
			return;
		}

		if (range.collapsed) return;
		const wrapper = document.createElement(tagAliases[0]!);
		try {
			range.surroundContents(wrapper);
		} catch {
			const fragment = range.extractContents();
			wrapper.appendChild(fragment);
			range.insertNode(wrapper);
		}
		sel.removeAllRanges();
		const restored = document.createRange();
		restored.selectNodeContents(wrapper);
		sel.addRange(restored);
		notify();
	}

	function toggleBold(): void {
		toggleInlineMark(['strong', 'b']);
	}

	function toggleItalic(): void {
		toggleInlineMark(['em', 'i']);
	}

	function toggleUnderline(): void {
		toggleInlineMark(['u']);
	}

	function applyBlockTag(tag: 'p' | 'h1' | 'h2' | 'blockquote'): void {
		const ctx = getCtx();
		if (!ctx) return;
		const block = getNearestBlock(editorRef.value, ctx.range.commonAncestorContainer);
		if (!block) return;
		if (block.tagName.toLowerCase() === tag) {
			const replaced = replaceTagPreservingChildren(block, 'p');
			selectNodeContents(replaced);
			notify();
			return;
		}
		const replaced = replaceTagPreservingChildren(block, tag);
		selectNodeContents(replaced);
		notify();
	}

	function toggleHeading(level: 1 | 2): void {
		applyBlockTag(level === 1 ? 'h1' : 'h2');
	}

	function toggleBlockquote(): void {
		applyBlockTag('blockquote');
	}

	function toggleList(ordered: boolean): void {
		const ctx = getCtx();
		if (!ctx) return;
		const targetListTag = ordered ? 'ol' : 'ul';
		const block = getNearestBlock(editorRef.value, ctx.range.commonAncestorContainer);
		if (!block) return;

		const li = findAncestor(editorRef.value, block, 'li');
		if (li) {
			const list = li.parentElement;
			if (list && list.tagName.toLowerCase() === targetListTag) {
				const fragment = document.createDocumentFragment();
				Array.from(list.children).forEach((child) => {
					const p = document.createElement('p');
					while (child.firstChild) p.appendChild(child.firstChild);
					fragment.appendChild(p);
				});
				list.replaceWith(fragment);
				notify();
				return;
			}
			if (list && list.tagName.toLowerCase() !== targetListTag) {
				const swapped = replaceTagPreservingChildren(list, targetListTag);
				selectNodeContents(swapped);
				notify();
				return;
			}
		}

		const newList = document.createElement(targetListTag);
		const item = document.createElement('li');
		while (block.firstChild) item.appendChild(block.firstChild);
		newList.appendChild(item);
		block.replaceWith(newList);
		selectNodeContents(item);
		notify();
	}

	async function setLink(): Promise<void> {
		const ctx = getCtx();
		if (!ctx) return;
		const { sel, range } = ctx;

		const existing = findAncestor(
			editorRef.value,
			range.commonAncestorContainer,
			'a',
		) as HTMLAnchorElement | null;
		const previousHref = existing?.getAttribute('href') ?? null;

		const fallbackPrompt = (current: string | null): string | null => {
			if (typeof window === 'undefined') return null;
			return window.prompt('Link URL', current ?? 'https://');
		};
		const resolver = promptForLink ?? fallbackPrompt;
		const url = await resolver(previousHref);
		if (url === null) return;

		if (url === '') {
			if (existing) {
				unwrapElement(existing);
				notify();
			}
			return;
		}

		if (existing) {
			existing.setAttribute('href', url);
			existing.setAttribute('target', '_blank');
			existing.setAttribute('rel', 'noreferrer noopener');
			notify();
			return;
		}

		if (range.collapsed) {
			const anchor = document.createElement('a');
			anchor.setAttribute('href', url);
			anchor.setAttribute('target', '_blank');
			anchor.setAttribute('rel', 'noreferrer noopener');
			anchor.textContent = url;
			range.insertNode(anchor);
			const after = document.createRange();
			after.setStartAfter(anchor);
			after.collapse(true);
			sel.removeAllRanges();
			sel.addRange(after);
			notify();
			return;
		}

		const anchor = document.createElement('a');
		anchor.setAttribute('href', url);
		anchor.setAttribute('target', '_blank');
		anchor.setAttribute('rel', 'noreferrer noopener');
		try {
			range.surroundContents(anchor);
		} catch {
			const fragment = range.extractContents();
			anchor.appendChild(fragment);
			range.insertNode(anchor);
		}
		selectNodeContents(anchor);
		notify();
	}

	/**
	 * Returns the active formatting marks for the current selection.
	 * Pure read; safe to call on every selectionchange.
	 */
	function readActiveMarks(): ActiveMarks {
		const ctx = getCtx();
		const node = ctx?.sel.anchorNode ?? null;
		if (!node) return { ...EMPTY_ACTIVE_MARKS };
		const editor = editorRef.value;
		return {
			bold: !!findAncestor(editor, node, ['strong', 'b']),
			italic: !!findAncestor(editor, node, ['em', 'i']),
			underline: !!findAncestor(editor, node, 'u'),
			h1: !!findAncestor(editor, node, 'h1'),
			h2: !!findAncestor(editor, node, 'h2'),
			ul: !!findAncestor(editor, node, 'ul'),
			ol: !!findAncestor(editor, node, 'ol'),
			quote: !!findAncestor(editor, node, 'blockquote'),
			link: !!findAncestor(editor, node, 'a'),
		};
	}

	/**
	 * Replace the current (non-collapsed) selection with `text`, routing through
	 * the browser's own edit pipeline (`execCommand('insertText')`) so the swap
	 * lands on the native undo stack as ONE step and the host's `@input` autosave
	 * sees it as real user text. Falls back to a manual range replace when
	 * `execCommand` is unavailable (older engines / JSDOM), which the caller can
	 * still undo through its own history. No-ops (returns false) when there is no
	 * selection inside the editor. Used by the AI selection-rewrite "Apply".
	 */
	function replaceSelection(text: string): boolean {
		const ctx = getCtx();
		if (!ctx) return false;
		editorRef.value?.focus();
		if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
			// On success the native `input` event fires and the host re-emits, so
			// don't also call notify() here (mirrors the ghost-text accept path).
			const ok = document.execCommand('insertText', false, text);
			if (ok) return true;
		}
		const { sel, range } = ctx;
		range.deleteContents();
		const node = document.createTextNode(text);
		range.insertNode(node);
		const after = document.createRange();
		after.setStartAfter(node);
		after.collapse(true);
		sel.removeAllRanges();
		sel.addRange(after);
		notify();
		return true;
	}

	/**
	 * Plain-text paste — drops alien `<style>`/`<font>` cruft from
	 * Word/Outlook. Call from the host's `@paste` handler.
	 */
	function pasteAsPlainText(event: ClipboardEvent): void {
		const text = event.clipboardData?.getData('text/plain');
		if (text == null) return;
		event.preventDefault();
		const ctx = getCtx();
		if (!ctx) return;
		const { sel, range } = ctx;
		range.deleteContents();
		const node = document.createTextNode(text);
		range.insertNode(node);
		const after = document.createRange();
		after.setStartAfter(node);
		after.collapse(true);
		sel.removeAllRanges();
		sel.addRange(after);
		notify();
	}

	/**
	 * Standard ⌘/Ctrl-B/I/U/K shortcut handler. Returns `true` when the event
	 * was consumed (caller should `event.preventDefault()` was already called).
	 */
	function handleFormatKeydown(event: KeyboardEvent): boolean {
		const meta = event.metaKey || event.ctrlKey;
		if (!meta) return false;
		const key = event.key.toLowerCase();
		if (key === 'b') {
			event.preventDefault();
			toggleBold();
			return true;
		}
		if (key === 'i') {
			event.preventDefault();
			toggleItalic();
			return true;
		}
		if (key === 'u') {
			event.preventDefault();
			toggleUnderline();
			return true;
		}
		if (key === 'k') {
			event.preventDefault();
			void setLink();
			return true;
		}
		return false;
	}

	return {
		// Selection helpers
		getSelection: getCtx,
		// Format toggles
		toggleBold,
		toggleItalic,
		toggleUnderline,
		toggleHeading,
		toggleBlockquote,
		toggleList,
		setLink,
		// State + events
		readActiveMarks,
		replaceSelection,
		pasteAsPlainText,
		handleFormatKeydown,
	};
}
