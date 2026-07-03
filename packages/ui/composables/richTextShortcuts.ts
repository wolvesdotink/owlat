/**
 * Notion-style markdown typing shortcuts for the shared `useRichText` composable.
 *
 * Extracted from `useRichText.ts` so that composable stays under the file-size
 * ratchet (scripts/check-file-size.sh). The public surface is unchanged:
 * `useRichText` composes {@link createMarkdownShortcuts} behind its
 * `patternShortcuts` opt-in and re-exports the three returned handlers
 * (`handleBeforeInput` / `handleShortcutUndoKeydown` / `resetShortcutUndo`).
 *
 * Conversions:
 *   - `"- "` / `"* "` at line start → bullet list
 *   - `"1. "` → ordered list
 *   - `"# "` / `"## "` → H1 / H2
 *   - `"> "` → blockquote
 *   - `**bold**` → bold, `*italic*` → italic, `` `code` `` → inline code
 *
 * Block markers fire on the trailing space; inline markers on the closing
 * character. Each conversion records a one-shot `undo` closure so the very next
 * Cmd/Ctrl+Z (with nothing typed in between) reverts to the literal marker text
 * — matching Notion. Any subsequent input clears it so a stale conversion is
 * never re-undone. Loop guards keep conversions from firing inside code spans,
 * `pre`, list items, or (for the `>` marker) an existing blockquote.
 */

import type { Ref } from 'vue';
import { findAncestor, getNearestBlock } from './useRichText';

/** Block markers → the block command they expand to, keyed on exact line text. */
type BlockShortcutKind = 'ul' | 'ol' | 'h1' | 'h2' | 'blockquote';
const BLOCK_SHORTCUTS: Readonly<Record<string, BlockShortcutKind>> = Object.freeze({
	'-': 'ul',
	'*': 'ul',
	'1.': 'ol',
	'#': 'h1',
	'##': 'h2',
	'>': 'blockquote',
});

export interface MarkdownShortcutDeps {
	/** Ref to the contenteditable host element. */
	editorRef: Ref<HTMLElement | null>;
	/** Resolve the active in-editor selection (mirror of `useRichText`'s ctx). */
	getCtx: () => { sel: Selection; range: Range } | null;
	/** Re-emit the editor HTML after a DOM mutation. */
	notify: () => void;
	/**
	 * Optional "convert on space" plain-text replacement (e.g. ASCII smileys
	 * `:)` → 🙂). Given the text before the caret, return the trailing span to
	 * swap, its replacement char(s), and the literal a single undo restores — or
	 * `null` when nothing matches. Fires through the SAME one-shot-undo plumbing as
	 * the markdown block/inline shortcuts (so consumers don't add a second parallel
	 * undo pathway). Kept as a caller-supplied matcher so the shortcode/emoji data
	 * stays out of `@owlat/ui`.
	 */
	asciiReplace?: (
		textBeforeCaret: string,
	) => { spanLen: number; replacement: string; literal: string } | null;
}

export interface MarkdownShortcuts {
	handleBeforeInput: (event: InputEvent) => boolean;
	handleShortcutUndoKeydown: (event: KeyboardEvent) => boolean;
	resetShortcutUndo: () => void;
}

/**
 * Build the markdown typing-shortcut handlers bound to the supplied editor
 * seam. The handlers assume the caller only wires them when its
 * `patternShortcuts` option is enabled; they perform no additional gating.
 */
export function createMarkdownShortcuts(deps: MarkdownShortcutDeps): MarkdownShortcuts {
	const { editorRef, getCtx, notify } = deps;

	// A conversion records a one-shot `undo` closure. The very next Cmd+Z (with
	// nothing typed in between) reverts to the literal marker text — matching
	// Notion. Any subsequent input clears it so a stale conversion is never
	// re-undone.
	let pendingUndo: (() => void) | null = null;

	function clearPendingUndo(): void {
		pendingUndo = null;
	}

	function placeCaret(node: Node, atEnd: boolean): void {
		const ctx = getCtx();
		const sel = ctx?.sel ?? (typeof window !== 'undefined' ? window.getSelection() : null);
		if (!sel) return;
		const range = document.createRange();
		range.selectNodeContents(node);
		range.collapse(!atEnd);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	function placeCaretAfter(node: Node): void {
		const sel = typeof window !== 'undefined' ? window.getSelection() : null;
		if (!sel) return;
		const range = document.createRange();
		range.setStartAfter(node);
		range.collapse(true);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	/** Exact text from the start of `block` up to the caret. */
	function textBeforeCaret(block: HTMLElement, node: Node, offset: number): string {
		const range = document.createRange();
		range.setStart(block, 0);
		range.setEnd(node, offset);
		return range.toString();
	}

	function tryBlockShortcut(): boolean {
		const ctx = getCtx();
		if (!ctx || !ctx.range.collapsed) return false;
		const focus = ctx.range.startContainer;
		if (!focus) return false;
		const editor = editorRef.value;
		// Loop guards: never expand inside code/pre, existing list items, or a
		// blockquote for the `>` marker — where it would surprise the typist.
		if (findAncestor(editor, focus, ['pre', 'code', 'li'])) return false;
		const block = getNearestBlock(editor, focus);
		if (!block) return false;
		const before = textBeforeCaret(block, focus, ctx.range.startOffset);
		const kind = Object.prototype.hasOwnProperty.call(BLOCK_SHORTCUTS, before)
			? BLOCK_SHORTCUTS[before]
			: undefined;
		if (!kind) return false;
		if (kind === 'blockquote' && findAncestor(editor, focus, 'blockquote')) return false;

		const literal = `${before} `; // what Cmd+Z restores (marker + the space)
		let replaced: HTMLElement;
		if (kind === 'ul' || kind === 'ol') {
			const list = document.createElement(kind);
			const li = document.createElement('li');
			li.appendChild(document.createElement('br'));
			list.appendChild(li);
			block.replaceWith(list);
			placeCaret(li, false);
			replaced = list;
		} else {
			const el = document.createElement(kind);
			el.appendChild(document.createElement('br'));
			block.replaceWith(el);
			placeCaret(el, false);
			replaced = el;
		}

		pendingUndo = () => {
			const p = document.createElement('p');
			p.textContent = literal;
			replaced.replaceWith(p);
			placeCaret(p, true);
			notify();
		};
		notify();
		return true;
	}

	function buildInlineMark(kind: 'strong' | 'em' | 'code', inner: string): HTMLElement {
		const el = document.createElement(kind);
		el.textContent = inner;
		return el;
	}

	function tryInlineShortcut(closingChar: string): boolean {
		const ctx = getCtx();
		if (!ctx || !ctx.range.collapsed) return false;
		const node = ctx.range.startContainer;
		if (!node || node.nodeType !== Node.TEXT_NODE) return false;
		const editor = editorRef.value;
		// Never re-convert inside an existing code span (loop guard).
		if (findAncestor(editor, node, ['code', 'pre'])) return false;
		const textNode = node as Text;
		const offset = ctx.range.startOffset;
		const before = textNode.data.slice(0, offset);
		const withChar = before + closingChar;

		let kind: 'strong' | 'em' | 'code' | null = null;
		let inner = '';
		let full = '';
		if (closingChar === '`') {
			const m = /`([^`]+)`$/.exec(withChar);
			if (m) {
				kind = 'code';
				inner = m[1]!;
				full = m[0];
			}
		} else if (closingChar === '*') {
			const boldM = /\*\*([^*]+)\*\*$/.exec(withChar);
			if (boldM) {
				kind = 'strong';
				inner = boldM[1]!;
				full = boldM[0];
			} else {
				const itM = /\*([^*]+)\*$/.exec(withChar);
				if (itM) {
					const start = withChar.length - itM[0].length;
					// Reject when the char before the opening `*` is another `*` — that
					// belongs to a (still-incomplete) bold run, not an italic.
					if (start === 0 || withChar[start - 1] !== '*') {
						kind = 'em';
						inner = itM[1]!;
						full = itM[0];
					}
				}
			}
		}
		if (!kind) return false;

		// The marker text already present in the node is `full` minus the not-yet-
		// typed closing char; it occupies [markerStart, offset).
		const markerLen = full.length - 1;
		const markerStart = offset - markerLen;
		if (markerStart < 0) return false;

		textNode.deleteData(markerStart, markerLen);
		const tail = textNode.splitText(markerStart);
		const el = buildInlineMark(kind, inner);
		textNode.parentNode?.insertBefore(el, tail);
		placeCaretAfter(el);

		pendingUndo = () => {
			const literalNode = document.createTextNode(full);
			el.replaceWith(literalNode);
			placeCaretAfter(literalNode);
			notify();
		};
		notify();
		return true;
	}

	/**
	 * Convert a caller-matched trailing plain-text span (e.g. an ASCII smiley) into
	 * its replacement char plus the space the user just pressed, recording the same
	 * one-shot literal-restore undo as the markdown conversions. Fires on the space
	 * keystroke (which the caller preventDefaults). Returns false when disabled or
	 * nothing matches.
	 */
	function tryAsciiReplace(): boolean {
		const matcher = deps.asciiReplace;
		if (!matcher) return false;
		const ctx = getCtx();
		if (!ctx || !ctx.range.collapsed) return false;
		const node = ctx.range.startContainer;
		if (!node || node.nodeType !== Node.TEXT_NODE) return false;
		const editor = editorRef.value;
		// Never convert inside a code span/pre (loop guard, mirrors the others).
		if (findAncestor(editor, node, ['code', 'pre'])) return false;
		const textNode = node as Text;
		const offset = ctx.range.startOffset;
		const before = textNode.data.slice(0, offset);
		const match = matcher(before);
		if (!match) return false;
		const spanStart = offset - match.spanLen;
		if (spanStart < 0) return false;

		const literal = `${match.literal} `; // what Cmd+Z restores (smiley + the space)
		// Swap the matched span for the replacement, absorbing the pressed space so
		// the caret lands after it just as a normal space keystroke would.
		textNode.deleteData(spanStart, match.spanLen);
		const tail = textNode.splitText(spanStart);
		const inserted = document.createTextNode(`${match.replacement} `);
		textNode.parentNode?.insertBefore(inserted, tail);
		placeCaretAfter(inserted);

		pendingUndo = () => {
			const literalNode = document.createTextNode(literal);
			inserted.replaceWith(literalNode);
			placeCaretAfter(literalNode);
			notify();
		};
		notify();
		return true;
	}

	/**
	 * `beforeinput` handler for markdown shortcuts. Returns `true` (and calls
	 * `event.preventDefault()`) when it consumed the input to perform a
	 * conversion; `false` otherwise.
	 */
	function handleBeforeInput(event: InputEvent): boolean {
		const inputType = event.inputType;
		if (inputType === 'insertText' && event.data === ' ') {
			if (tryBlockShortcut()) {
				event.preventDefault();
				return true;
			}
			if (tryAsciiReplace()) {
				event.preventDefault();
				return true;
			}
			clearPendingUndo();
			return false;
		}
		if (inputType === 'insertText' && (event.data === '*' || event.data === '`')) {
			if (tryInlineShortcut(event.data)) {
				event.preventDefault();
				return true;
			}
			clearPendingUndo();
			return false;
		}
		// Any other input invalidates the one-shot literal-restore undo.
		clearPendingUndo();
		return false;
	}

	/**
	 * Keydown handler that turns the first Cmd/Ctrl+Z after a shortcut conversion
	 * into a literal-text restore (single undo step, Notion-style). Returns `true`
	 * (and calls `preventDefault`) when it handled the undo; `false` otherwise.
	 */
	function handleShortcutUndoKeydown(event: KeyboardEvent): boolean {
		const meta = event.metaKey || event.ctrlKey;
		if (!meta || event.shiftKey || event.key.toLowerCase() !== 'z') return false;
		if (!pendingUndo) return false;
		event.preventDefault();
		const undo = pendingUndo;
		pendingUndo = null;
		undo();
		return true;
	}

	/** Drop the pending literal-restore (e.g. on caret move / blur). */
	function resetShortcutUndo(): void {
		clearPendingUndo();
	}

	return { handleBeforeInput, handleShortcutUndoKeydown, resetShortcutUndo };
}
