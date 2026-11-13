import { onBeforeUnmount, onMounted, type Ref } from 'vue';

/**
 * Selection and focus routing for `PostboxBasicEditor`.
 *
 * Every advisory overlay the editor hosts (ghost text, the emoji and snippet
 * pickers, the AI rewrite pill, the floating format bar) is anchored to the
 * caret or the selection. A caret move or a blur has to re-place or dismiss
 * each of them, and the floating bar must survive focus moving into it, so a
 * keyboard user can reach its commands. The routing lives here as one pathway,
 * next to the document-level `selectionchange` listener that drives it.
 */
export interface PostboxEditorSelectionSyncDeps {
	editorRef: Ref<HTMLDivElement | null>;
	formatBarRef: Ref<{ $el?: HTMLElement } | null>;
	/** Re-emit the editor HTML. */
	emitContent: () => void;
	/** `useRichText` pieces: the live selection and the one-shot undo reset. */
	getSelection: () => unknown;
	resetShortcutUndo: () => void;
	/** Re-read the toolbar's active marks from the selection. */
	syncActiveMarks: () => void;
	refreshFormatBar: () => void;
	hideFormatBar: () => void;
	ghost: { hasGhost: () => boolean; cancel: () => void };
	emoji: { open: Ref<boolean>; refresh: () => void; close: () => void };
	snippetPicker: { onSelectionChange: () => void; close: () => void };
	rewrite: { onSelectionChange: () => void; dispose: () => void };
}

export function usePostboxEditorSelectionSync(deps: PostboxEditorSelectionSyncDeps) {
	const { ghost, emoji, snippetPicker } = deps;

	function focusInFormatBar(target: EventTarget | null): boolean {
		const bar = deps.formatBarRef.value?.$el;
		return !!bar && target instanceof Node && bar.contains(target);
	}

	function onBlur(event: FocusEvent) {
		deps.emitContent();
		ghost.cancel(); // never leave a ghost hanging over an unfocused editor
		deps.resetShortcutUndo(); // a literal-restore undo (markdown/ASCII) shouldn't survive leaving the editor
		emoji.close(); // never leave the picker popover open over an unfocused editor
		// Tab from a selection lands on the floating bar: it stays, so a keyboard
		// user can reach its commands. Anywhere else, it goes.
		if (!focusInFormatBar(event.relatedTarget)) deps.hideFormatBar();
		snippetPicker.close(); // …nor the snippet picker over an unfocused editor
	}

	// Focus leaving the floating bar for anything but the editor hides it.
	function onFormatBarFocusOut(event: FocusEvent) {
		const next = event.relatedTarget;
		if (focusInFormatBar(next)) return;
		if (next instanceof Node && deps.editorRef.value?.contains(next)) return;
		deps.hideFormatBar();
	}

	function onSelectionChange() {
		if (deps.getSelection()) deps.syncActiveMarks();
		// A caret move (arrow/click) invalidates a shown ghost. Only dismiss when one
		// is visible, so this can't clear a request still pending in its debounce.
		if (ghost.hasGhost()) ghost.cancel();
		// A caret move re-evaluates an OPEN emoji picker (closes it if the trigger is gone).
		if (emoji.open.value) emoji.refresh();
		// A caret move out of the ";token" run closes the snippet picker; a move within
		// it (e.g. after inserting a char) refreshes the query + position.
		snippetPicker.onSelectionChange();
		// A selection change aborts an in-flight rewrite (its anchor is now stale)
		// and re-places the pill for the new selection.
		deps.rewrite.onSelectionChange();
		// Re-place (or hide) the floating format bar for the new selection.
		deps.refreshFormatBar();
	}

	// Content init + the incoming `modelValue` watcher live in usePostboxEditorDocument;
	// this only owns the document-level selectionchange listener.
	onMounted(() => {
		document.addEventListener('selectionchange', onSelectionChange);
	});

	onBeforeUnmount(() => {
		document.removeEventListener('selectionchange', onSelectionChange);
		ghost.cancel();
		emoji.close();
		snippetPicker.close();
		deps.rewrite.dispose();
	});

	return { onBlur, onFormatBarFocusOut };
}
