/**
 * Inline `:shortcode:` emoji picker for the Postbox composer.
 *
 * Typing `:` followed by >=2 characters opens a compact popover of fuzzy-matched
 * emoji at the caret; arrow keys move the highlight, Enter/Tab inserts the
 * emoji char (plain text), Esc closes and leaves the literal `:sm` text
 * untouched. The list, its highlight and its keys are the shared
 * `UiSuggestionPopover` (rendered by `PostboxEmojiPicker`); this controller
 * keeps the trigger, the matching and the insertion.
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
import { shallowRef, type Ref } from 'vue';
import type { SuggestionListHandle } from '@owlat/ui/utils/listboxField';
import { selectionCaretAnchor, type VirtualAnchor } from '@owlat/ui/utils/popoverAnchor';
import { detectShortcodeTrigger, fuzzyFilterEmoji } from '~/utils/postboxEmojiShortcodes';
import type { PostboxEmoji } from '~/utils/postboxEmojiData';
import { isImeComposing } from '~/utils/imeComposition';

export interface EmojiPickerOptions {
	editorRef: Ref<HTMLElement | null>;
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
	// The caret box the list hangs from, measured when the trigger was read.
	const anchor = shallowRef<VirtualAnchor | null>(null);
	// The rendered list, which owns ↑ ↓ Enter Tab and the highlight.
	const list = shallowRef<SuggestionListHandle | null>(null);

	/**
	 * Template ref for the rendered list. One stable function: an inline arrow
	 * would be a new ref every render, which Vue answers by clearing and
	 * re-setting it, and that write would render again.
	 */
	function bindList(rendered: unknown) {
		list.value = rendered as SuggestionListHandle | null;
	}

	// The trigger span being replaced on insert (`:` + query length).
	let triggerLen = 0;

	function close() {
		open.value = false;
		items.value = [];
		anchor.value = null;
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
		// No caret box (an unmeasurable caret): the list stays hidden.
		anchor.value = selectionCaretAnchor(opts.editorRef.value);
		open.value = true;
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

	/**
	 * Keydown handler; returns true when the picker consumed the event so the
	 * editor stops its own handling (arrows/Enter/Tab/Esc while open). A pick
	 * comes back through `insert`.
	 */
	function handleKeydown(event: KeyboardEvent): boolean {
		// An IME's keys (Escape cancels its composition) stay the IME's.
		if (!open.value || isImeComposing(event)) return false;
		if (list.value?.handleKeydown(event)) return true;
		// The shown list's escape layer takes Esc first; this covers a list
		// that could not be placed.
		if (event.key === 'Escape') {
			event.preventDefault();
			close(); // leave the literal `:sm` text as typed
			return true;
		}
		return false;
	}

	return {
		open,
		items,
		anchor,
		list,
		bindList,
		refresh,
		close,
		insert,
		handleKeydown,
	};
}
