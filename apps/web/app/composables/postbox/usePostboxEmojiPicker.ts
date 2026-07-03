/**
 * Inline `:shortcode:` emoji picker + ASCII-smiley conversion for the Postbox
 * composer.
 *
 * Typing `:` followed by >=2 characters opens a compact popover of fuzzy-matched
 * emoji at the caret (same lean caret-anchored placement as the ghost overlay);
 * arrow keys move the selection, Enter/Tab inserts the emoji char (plain text),
 * Esc closes and leaves the literal `:sm` text untouched. Separately, well-known
 * ASCII smileys (`:)` -> 🙂) convert on the following space as a single undo step
 * (same one-shot literal-restore pattern as the markdown typing shortcuts).
 *
 * All caret/DOM plumbing lives here so `PostboxBasicEditor.vue` stays under the
 * file-size ratchet. The picker is opt-in (`enabled`) so the editor's other mount
 * sites (e.g. signatures) never surface it. Nothing here calls the network.
 */
import type { Ref } from 'vue';
import {
	detectShortcodeTrigger,
	fuzzyFilterEmoji,
	matchAsciiSmiley,
	type PostboxEmoji,
} from '~/utils/postboxEmojiShortcodes';

export interface EmojiPickerOptions {
	editorRef: Ref<HTMLElement | null>;
	surfaceRef: Ref<HTMLElement | null>;
	/** True when the picker + ASCII conversion are enabled (Postbox composer only). */
	enabled: () => boolean;
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
	// One-shot literal-restore for an ASCII conversion (mirrors markdown shortcuts):
	// the very next Cmd/Ctrl+Z restores the typed smiley text.
	let pendingUndo: (() => void) | null = null;

	function close() {
		open.value = false;
		items.value = [];
		activeIndex.value = 0;
		style.value = null;
		triggerLen = 0;
		// A stale ASCII literal-restore must not survive the popover closing / blur.
		pendingUndo = null;
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
		const surface = opts.surfaceRef.value;
		const sel = window.getSelection();
		if (!surface || !sel || sel.rangeCount === 0) {
			style.value = null;
			return;
		}
		const range = sel.getRangeAt(0).cloneRange();
		range.collapse(false);
		const rects = range.getClientRects();
		const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
		if (!rect || (rect.top === 0 && rect.left === 0 && rect.height === 0)) {
			style.value = null;
			return;
		}
		const host = surface.getBoundingClientRect();
		style.value = {
			left: `${rect.left - host.left + surface.scrollLeft}px`,
			top: `${rect.bottom - host.top + surface.scrollTop + 4}px`,
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

	/** Select the text span immediately before the caret and replace it with `text`. */
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
		// execCommand routes through the browser's own edit pipeline so native undo
		// and the @input autosave both treat the swap as real user editing.
		if (!document.execCommand('insertText', false, text)) {
			select.deleteContents();
			const inserted = document.createTextNode(text);
			select.insertNode(inserted);
			select.setStartAfter(inserted);
			select.collapse(true);
			sel.removeAllRanges();
			sel.addRange(select);
		}
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

	/**
	 * `beforeinput` handler for the ASCII-smiley conversion on space. Returns true
	 * (and preventDefaults) when it converted a trailing smiley; false otherwise.
	 */
	function handleBeforeInput(event: InputEvent): boolean {
		if (!opts.enabled()) return false;
		if (event.inputType !== 'insertText' || event.data !== ' ') {
			pendingUndo = null;
			return false;
		}
		const before = caretText();
		if (before == null) {
			pendingUndo = null;
			return false;
		}
		const match = matchAsciiSmiley(before);
		if (!match) {
			pendingUndo = null;
			return false;
		}
		event.preventDefault();
		const literal = `${match.ascii} `; // what a single undo restores (smiley + space)
		// Replace the smiley with the emoji char, then let the space land after it.
		replaceBeforeCaret(match.ascii.length, `${match.char} `);
		const emojiLen = match.char.length + 1;
		pendingUndo = () => {
			replaceBeforeCaret(emojiLen, literal);
			opts.emitContent();
		};
		opts.emitContent();
		return true;
	}

	/**
	 * Keydown handler that turns the first Cmd/Ctrl+Z after an ASCII conversion into
	 * a single literal-restore step. Returns true when it handled the undo.
	 */
	function handleUndoKeydown(event: KeyboardEvent): boolean {
		const meta = event.metaKey || event.ctrlKey;
		if (!meta || event.shiftKey || event.key.toLowerCase() !== 'z') return false;
		if (!pendingUndo) return false;
		event.preventDefault();
		const undo = pendingUndo;
		pendingUndo = null;
		undo();
		return true;
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
		handleBeforeInput,
		handleUndoKeydown,
	};
}
