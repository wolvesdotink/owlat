/**
 * Keyboard/beforeinput routing for `PostboxBasicEditor`.
 *
 * The composer's contenteditable multiplexes one `keydown`/`beforeinput` stream
 * across several advisory affordances — the `:shortcode:` emoji picker, ghost
 * text, the AI rewrite pill, the shared markdown/ASCII one-shot undo, and the
 * plain format shortcuts. Ordering matters (an open picker owns arrows/Enter
 * before ghost text sees them), so the routing lives here as one linear
 * pathway, keeping the component under the file-size ratchet and unit-testable
 * without mounting the SFC.
 */

export interface PostboxEditorInputDeps {
	/** `useRichText.handleBeforeInput` — markdown + ASCII smiley interception. */
	handleBeforeInput: (event: InputEvent) => boolean;
	/** `useRichText.handleShortcutUndoKeydown` — one-shot literal restore. */
	handleShortcutUndoKeydown: (event: KeyboardEvent) => boolean;
	/** `useRichText.handleFormatKeydown` — B/I/U and friends. */
	handleFormatKeydown: (event: KeyboardEvent) => void;
	/** Re-emit the editor HTML after a DOM mutation that skipped `@input`. */
	emitContent: () => void;
	/** The `:shortcode:` emoji picker; consumes arrows/Enter/Tab/Esc when open. */
	emoji: { handleKeydown: (event: KeyboardEvent) => boolean };
	/** Inline ghost text; Tab accepts, Esc cancels, any other key dismisses. */
	ghost: { hasGhost: () => boolean; accept: () => void; cancel: () => void };
	/** AI rewrite controller; Esc dismisses the pill, edits invalidate a preview. */
	rewrite: { invalidateOnEdit: () => void; handleEscape: () => boolean };
}

export function usePostboxEditorInput(deps: PostboxEditorInputDeps) {
	// Markdown shortcuts AND the ASCII-smiley conversion intercept the raw input
	// BEFORE the character lands (both via the shared `handleBeforeInput`), so a
	// conversion never flickers the literal marker into the DOM. When consumed the
	// composable has already called preventDefault().
	function onBeforeInput(event: InputEvent) {
		if (deps.handleBeforeInput(event)) {
			// The conversion mutates the DOM directly without firing @input, so emit
			// the new content and re-run the rewrite bookkeeping the input path would.
			deps.emitContent();
			deps.rewrite.invalidateOnEdit();
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (deps.emoji.handleKeydown(event)) return; // open picker owns arrows/Enter/Tab/Esc
		// A conversion's first Cmd+Z restores the literal marker/smiley text (one undo
		// step) — markdown shortcuts and the ASCII smiley share this one pathway.
		if (deps.handleShortcutUndoKeydown(event)) {
			deps.emitContent();
			return;
		}
		if (deps.ghost.hasGhost()) {
			if (event.key === 'Tab') {
				event.preventDefault();
				deps.ghost.accept();
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				deps.ghost.cancel();
				return;
			}
			// Any other key: the draft is changing under the ghost — dismiss it.
			deps.ghost.cancel();
		}
		// Escape dismisses a rewrite pill/preview without touching the selection.
		if (event.key === 'Escape' && deps.rewrite.handleEscape()) {
			event.preventDefault();
			return;
		}
		deps.handleFormatKeydown(event);
	}

	return { onBeforeInput, onKeydown };
}
