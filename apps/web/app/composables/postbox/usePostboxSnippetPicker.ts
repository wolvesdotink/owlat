/**
 * Saved-reply PICKER controller for the Postbox Simple composer: the `;` (or
 * `/`) trigger typed into the text, and insertion at the caret for the
 * composer's own picker and the command palette.
 *
 * This is the Selection/Range + keyboard glue that sits between
 * {@link PostboxBasicEditor}'s contenteditable and the pure trigger/rank/
 * placeholder helpers in `~/utils/postboxSnippets`. It owns the picker's open
 * state, filter query, active-item index, caret-anchored placement and the
 * insert-through-the-edit-pipeline lifecycle.
 *
 * Extracted out of `PostboxBasicEditor.vue` to keep that SFC under the
 * file-size ratchet — mirroring the `usePostboxGhostText` /
 * `usePostboxRewriteController` seams the editor already delegates to. The
 * editor hands us its refs plus an `emitContent` callback and delegates the
 * input / keydown / selection / blur hooks; everything snippet-picker lives
 * here.
 *
 * Typing `;` at the start of a line (or after whitespace) opens the picker
 * while some reply matches; filter-as-you-type, arrow keys + Enter/Tab to
 * insert, Esc to dismiss (the literal `;` is never removed until a reply is
 * chosen). Insertion routes through `document.execCommand` so native undo +
 * the @input autosave both see it.
 *
 * Variables resolve at insertion from the recipient, the sender identity, the
 * subject and the date. A reply carrying `prompt` variables PAUSES here — the
 * trigger token is consumed, the caret position remembered, and the body is
 * inserted once the dialog hands back the answers. Anything still unresolved
 * becomes a `[[...]]` gap, which holds Send until it is filled.
 */

import { ref, computed, nextTick, type Ref } from 'vue';
import { detectSnippetTrigger, rankSnippets } from '~/utils/postboxSnippets';
import {
	promptedSnippetVariables,
	resolveSnippetBody,
	type ResolveSnippetOptions,
	type ResolvedSnippet,
	type SnippetVariable,
	type SnippetVariableContext,
} from '~/utils/postboxSnippetVariables';

/** A saved reply offered by the composer's picker and `;` trigger. */
export interface EditorSnippet {
	_id: string;
	name: string;
	shortcut: string;
	bodyHtml: string;
	/** Typed variable declarations (plan idea 13); absent = implicit tokens only. */
	variables?: SnippetVariable[];
	/** Shared with the organization (the picker marks it). */
	isShared?: boolean;
	useCount?: number;
	lastUsedAt?: number | null;
}

/** What the composer hands the editor for inserting replies. */
export interface SnippetInsertOptions {
	/**
	 * Everything a variable can resolve from at insert time: recipient facts,
	 * the sender's identity, the subject, today's date. An absent value makes
	 * its variable a `[[...]]` gap.
	 */
	variableContext: SnippetVariableContext;
	gapLabel?: ResolveSnippetOptions['gapLabel'];
	/** A reply went in (counted for the picker's order; gaps guard Send). */
	onInserted?: (snippet: EditorSnippet, resolved: ResolvedSnippet) => void;
}

/** A snippet held open waiting for its prompt-on-insert answers. */
export interface SnippetPromptRequest {
	snippet: EditorSnippet;
	fields: SnippetVariable[];
}

export interface SnippetPickerOptions {
	editorRef: Ref<HTMLDivElement | null>;
	surfaceRef: Ref<HTMLDivElement | null>;
	/** Saved replies; empty/undefined disables the trigger entirely. */
	snippets: () => EditorSnippet[] | undefined;
	insertOptions: () => SnippetInsertOptions | undefined;
	/** Re-emit the editor's HTML after an insert mutates the DOM. */
	emitContent: () => void;
}

export function usePostboxSnippetPicker(opts: SnippetPickerOptions) {
	const open = ref(false);
	const query = ref('');
	const index = ref(0);
	const style = ref<Record<string, string> | null>(null);
	// The trigger token last dismissed with Esc — suppresses immediate reopening
	// while the caret still sits in the same ";token" run.
	const dismissed = ref<string | null>(null);
	// A chosen snippet waiting on its prompt-on-insert answers.
	const prompt = ref<SnippetPromptRequest | null>(null);
	// Where the caret last was inside the editor, for an insert from outside it
	// (the composer's picker button, the command palette).
	let lastRange: Range | null = null;

	const items = computed(() => rankSnippets(opts.snippets() ?? [], query.value));

	function hasSnippets() {
		return (opts.snippets()?.length ?? 0) > 0;
	}

	/** Text from the start of the caret's text node up to the caret, or null. */
	function getCaretText(): string | null {
		const el = opts.editorRef.value;
		const sel = window.getSelection();
		if (!el || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
		const node = sel.focusNode;
		if (!node || !el.contains(node)) return null;
		if (node.nodeType !== Node.TEXT_NODE) return '';
		return (node.textContent ?? '').slice(0, sel.focusOffset);
	}

	function close() {
		open.value = false;
		style.value = null;
	}

	function dismiss() {
		const before = getCaretText();
		const trigger = before == null ? null : detectSnippetTrigger(before);
		dismissed.value = trigger ? `${trigger.triggerStart}:${trigger.query}` : null;
		close();
	}

	/** Position the picker just below the caret; drop it if unmeasurable. */
	function position() {
		const surface = opts.surfaceRef.value;
		const sel = window.getSelection();
		if (!surface || !sel || sel.rangeCount === 0) return close();
		const range = sel.getRangeAt(0).cloneRange();
		range.collapse(false);
		const rects = range.getClientRects();
		const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
		if (!rect || (rect.top === 0 && rect.left === 0 && rect.height === 0)) {
			return close();
		}
		const host = surface.getBoundingClientRect();
		style.value = {
			left: `${rect.left - host.left + surface.scrollLeft}px`,
			top: `${rect.bottom - host.top + surface.scrollTop + 4}px`,
		};
	}

	/** Re-evaluate the trigger after an edit; open/refresh/close the picker. */
	function update() {
		if (!hasSnippets()) return close();
		const before = getCaretText();
		const trigger = before == null ? null : detectSnippetTrigger(before);
		if (!trigger) {
			dismissed.value = null;
			return close();
		}
		const token = `${trigger.triggerStart}:${trigger.query}`;
		if (dismissed.value === token) return; // stay closed until token changes
		dismissed.value = null;
		query.value = trigger.query;
		// ";)" is a wink, not a shortcut: only open over something to pick.
		if (items.value.length === 0) return close();
		if (!open.value) {
			open.value = true;
			index.value = 0;
		}
		index.value = Math.min(index.value, Math.max(0, items.value.length - 1));
		void nextTick(() => position());
	}

	function next() {
		const max = items.value.length;
		if (max === 0) return;
		index.value = (index.value + 1) % max;
	}

	function prev() {
		const max = items.value.length;
		if (max === 0) return;
		index.value = (index.value - 1 + max) % max;
	}

	/** Write resolved HTML at the caret through the edit pipeline. */
	function writeHtml(html: string) {
		const ok = document.execCommand('insertHTML', false, html);
		if (ok) return;
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0) {
			const range = sel.getRangeAt(0);
			range.deleteContents();
			const frag = range.createContextualFragment(html);
			range.insertNode(frag);
			range.collapse(false);
		}
	}

	function resolveAndWrite(snippet: EditorSnippet, answers: Record<string, string>) {
		const insert = opts.insertOptions();
		const resolved = resolveSnippetBody(snippet.bodyHtml, {
			declared: snippet.variables ?? [],
			context: insert?.variableContext ?? {},
			gapLabel: insert?.gapLabel,
			answers,
		});
		writeHtml(resolved.html);
		opts.emitContent();
		insert?.onInserted?.(snippet, resolved);
	}

	/** Ask the prompt variables first, or write the reply straight away. */
	function begin(snippet: EditorSnippet) {
		const fields = promptedSnippetVariables(snippet.bodyHtml, snippet.variables ?? []);
		if (fields.length > 0) {
			prompt.value = { snippet, fields };
			return;
		}
		resolveAndWrite(snippet, {});
	}

	/**
	 * Replace the ";token" with the snippet body. A snippet with prompt-on-insert
	 * variables consumes the trigger and parks itself in `prompt` instead: the
	 * ";" is already gone, so the caret is where the body belongs, and the dialog
	 * completes the insert with `submitPrompt`.
	 */
	function insert(snippet: EditorSnippet) {
		const el = opts.editorRef.value;
		if (!el) return;
		const before = getCaretText();
		const trigger = before == null ? null : detectSnippetTrigger(before);
		close();
		dismissed.value = null;
		el.focus();
		const tokenLen = trigger ? 1 + trigger.query.length : 0;
		for (let i = 0; i < tokenLen; i++) document.execCommand('delete', false);
		begin(snippet);
	}

	/**
	 * Insert a reply chosen outside the text (the composer's picker, the command
	 * palette) where the caret last was, or at the start of an editor that was
	 * never clicked into.
	 */
	function insertAtCaret(snippet: EditorSnippet) {
		const el = opts.editorRef.value;
		if (!el) return;
		close();
		el.focus();
		const sel = window.getSelection();
		const inside = !!sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).startContainer);
		if (sel && !inside && lastRange && el.contains(lastRange.startContainer)) {
			sel.removeAllRanges();
			sel.addRange(lastRange);
		}
		begin(snippet);
	}

	/** The dialog answered: finish the parked insert at the remembered caret. */
	function submitPrompt(answers: Record<string, string>) {
		const parked = prompt.value;
		prompt.value = null;
		if (!parked) return;
		opts.editorRef.value?.focus();
		resolveAndWrite(parked.snippet, answers);
	}

	/**
	 * The dialog was cancelled. The body is NOT inserted — a half-filled canned
	 * response the sender backed out of is worse than none — but the consumed
	 * ";token" stays consumed, because re-typing it is trivial and re-inserting
	 * text into a contenteditable the user has since clicked away from is not.
	 */
	function cancelPrompt() {
		prompt.value = null;
	}

	/**
	 * Handle a keydown while the picker owns navigation. Returns true when the
	 * key was consumed (the caller must then stop its own handling).
	 */
	function handleKeydown(event: KeyboardEvent): boolean {
		if (!open.value) return false;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			next();
			return true;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			prev();
			return true;
		}
		if (event.key === 'Enter' || event.key === 'Tab') {
			const selected = items.value[index.value];
			if (selected) {
				event.preventDefault();
				insert(selected);
				return true;
			}
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			dismiss();
			return true;
		}
		return false;
	}

	/** A caret move within the ";token" run refreshes it; a move out closes. */
	function onSelectionChange() {
		const sel = window.getSelection();
		const el = opts.editorRef.value;
		if (sel && sel.rangeCount > 0 && el?.contains(sel.getRangeAt(0).startContainer)) {
			lastRange = sel.getRangeAt(0).cloneRange();
		}
		if (!open.value) return;
		const before = getCaretText();
		const trigger = before == null ? null : detectSnippetTrigger(before);
		if (!trigger) return close();
		query.value = trigger.query;
		position();
	}

	return {
		open,
		items,
		index,
		style,
		prompt,
		update,
		insert,
		insertAtCaret,
		submitPrompt,
		cancelPrompt,
		close,
		handleKeydown,
		onSelectionChange,
	};
}

/** The controller's public surface, as the editor and its overlays see it. */
export type SnippetPickerApi = ReturnType<typeof usePostboxSnippetPicker>;
