/**
 * Inline `:shortcode:` emoji picker for the Postbox composer.
 *
 * Typing `:` followed by >=2 characters opens a compact popover of fuzzy-matched
 * emoji at the caret (same lean caret-anchored placement as the ghost overlay,
 * via the shared `measureCaretRect`); arrow keys move the selection, Enter/Tab
 * inserts the emoji char (plain text), Esc closes and leaves the literal `:sm`
 * text untouched.
 *
 * The sibling ASCII-smiley conversion (`:)` -> 🙂 on space, one undo step) is NOT
 * here — it rides the shared markdown-shortcut one-shot-undo plumbing in
 * `@owlat/ui/composables/richTextShortcuts` (wired via `useRichText`'s
 * `asciiReplace` option) so the editor runs a single undo pathway, not two.
 *
 * All caret/DOM plumbing lives here so `PostboxBasicEditor.vue` stays under the
 * file-size ratchet. The picker is opt-in (`enabled`) so the editor's other mount
 * sites (e.g. signatures) never surface it. Nothing here calls the network.
 */
import type { Ref } from 'vue';
import {
	detectShortcodeTrigger,
	fuzzyFilterEmoji,
	type PostboxEmoji,
} from '~/utils/postboxEmojiShortcodes';
import { measureCaretRect } from '~/utils/postboxCaretRect';

export interface EmojiPickerOptions {
	editorRef: Ref<HTMLElement | null>;
	surfaceRef: Ref<HTMLElement | null>;
	/** True when the picker is enabled (Postbox composer only). */
	enabled: () => boolean;
	/**
	 * Replace the current in-editor selection with plain text, routing through the
	 * shared `useRichText` helper (execCommand insertText + manual fallback) so the
	 * swap lands on the native undo stack and the host's `@input` autosave sees it.
	 */
	replaceSelection: (text: string) => boolean;
	/** Re-emit + re-sync the draft after a DOM mutation. */
	emitContent: () => void;
}

const MAX_RESULTS = 8;

export function usePostboxEmojiPicker(opts: EmojiPickerOptions) {
	const open = ref(false);
	const items = ref<PostboxEmoji[]>([]);
	const activeIndex = ref(0);
	const style = ref<Record<string, string> | null>(null);

	// The trigger span being replaced on insert (`:` + query length).
	let triggerLen = 0;

	function close() {
		open.value = false;
		items.value = [];
		activeIndex.value = 0;
		style.value = null;
		triggerLen = 0;
	}

	/** Text of the caret's text node up to the caret, or null when not applicable. */
	function caretText(): string | null {
		const el = opts.editorRef.value;
		if (!el) return null;
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
		const node = sel.focusNode;
		if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return null;
		return (node.textContent ?? '').slice(0, sel.focusOffset);
	}

	/** Place the popover just below the caret; hide it if the rect is unmeasurable. */
	function position() {
		const rect = measureCaretRect(opts.surfaceRef.value);
		if (!rect) {
			style.value = null;
			return;
		}
		style.value = {
			left: `${rect.left}px`,
			top: `${rect.bottom + 4}px`,
		};
	}

	/** Re-evaluate the trigger at the caret after an input/selection change. */
	function refresh() {
		if (!opts.enabled()) {
			close();
			return;
		}
		const before = caretText();
		if (before == null) {
			close();
			return;
		}
		const trigger = detectShortcodeTrigger(before);
		if (!trigger) {
			close();
			return;
		}
		const hits = fuzzyFilterEmoji(trigger.query, MAX_RESULTS);
		if (hits.length === 0) {
			close();
			return;
		}
		triggerLen = 1 + trigger.query.length; // colon + query
		items.value = hits;
		activeIndex.value = 0;
		open.value = true;
		void nextTick(position);
	}

	/** Select the `:query` span immediately before the caret and replace it with `text`. */
	function replaceBeforeCaret(spanLen: number, text: string) {
		const el = opts.editorRef.value;
		const sel = window.getSelection();
		if (!el || !sel || sel.rangeCount === 0) return;
		const range = sel.getRangeAt(0);
		const node = range.startContainer;
		const offset = range.startOffset;
		if (node.nodeType !== Node.TEXT_NODE || offset < spanLen) return;
		const select = document.createRange();
		select.setStart(node, offset - spanLen);
		select.setEnd(node, offset);
		sel.removeAllRanges();
		sel.addRange(select);
		// Delegate the insert to the shared richText helper (native undo + autosave).
		opts.replaceSelection(text);
	}

	function insert(emoji: PostboxEmoji | undefined) {
		if (!emoji || !open.value || triggerLen <= 0) return;
		replaceBeforeCaret(triggerLen, emoji.char);
		opts.emitContent();
		close();
	}

	function insertActive() {
		const emoji = items.value[activeIndex.value];
		if (emoji) insert(emoji);
	}

	function move(delta: number) {
		if (!open.value || items.value.length === 0) return;
		const count = items.value.length;
		activeIndex.value = (activeIndex.value + delta + count) % count;
	}

	function setActive(index: number) {
		if (index >= 0 && index < items.value.length) activeIndex.value = index;
	}

	/**
	 * Keydown handler; returns true when the picker consumed the event so the
	 * editor stops its own handling (arrows/Enter/Tab/Esc while open).
	 */
	function handleKeydown(event: KeyboardEvent): boolean {
		if (!open.value) return false;
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				move(1);
				return true;
			case 'ArrowUp':
				event.preventDefault();
				move(-1);
				return true;
			case 'Enter':
			case 'Tab':
				event.preventDefault();
				insertActive();
				return true;
			case 'Escape':
				event.preventDefault();
				close(); // leave the literal `:sm` text as typed
				return true;
			default:
				return false;
		}
	}

	return {
		open,
		items,
		activeIndex,
		style,
		refresh,
		close,
		insert,
		setActive,
		handleKeydown,
	};
}
