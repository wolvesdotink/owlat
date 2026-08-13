/**
 * The editor's global keydown routing.
 *
 * Extracted from EmailBuilder.vue as a pure resolver — event in, intent out —
 * so every binding is unit-testable without mounting the editor, and so the
 * component is left with nothing but the dispatch. Every shortcut resolved here
 * is listed in `EDITOR_SHORTCUTS` (editorShortcuts.ts) so it shows up in the
 * keyboard shortcuts help sheet.
 */
import { isEditableTarget } from './canvasListboxNav';
import type { MoveDirection } from './blockMove';

export type EditorKeyAction =
	| { type: 'exit-inline-edit' }
	| { type: 'undo' }
	| { type: 'redo' }
	| { type: 'show-shortcuts' }
	| { type: 'move'; direction: MoveDirection }
	| { type: 'delete' }
	| { type: 'duplicate' };

export interface EditorKeyContext {
	/** An inline text editor has the caret. */
	isInlineEditing: boolean;
	/** The keyboard shortcuts help sheet is open. */
	isShortcutsDialogOpen: boolean;
	/** A block (or nested item) is selected, so block-level keys have a subject. */
	hasActiveBlock: boolean;
}

/**
 * The editor action a keystroke maps to, or `null` when the editor should keep
 * its hands off it. A non-null result always means "handled": the caller
 * preventDefaults and dispatches.
 */
export function resolveEditorKeyAction(
	event: KeyboardEvent,
	ctx: EditorKeyContext
): EditorKeyAction | null {
	const isEditable = isEditableTarget(event.target);

	// Escape leaves inline editing first — before the help sheet check, since the
	// caret is the more urgent thing to get back.
	if (event.key === 'Escape' && ctx.isInlineEditing) return { type: 'exit-inline-edit' };

	// The shortcuts sheet has no inputs of its own, so block-level keys (Delete,
	// Alt+Arrow, …) would otherwise still act on the canvas behind it.
	if (ctx.isShortcutsDialogOpen) return null;

	// Undo/Redo (Cmd/Ctrl+Z). `event.key` is uppercase while Shift is held, so
	// lowercase it — otherwise Cmd/Ctrl+Shift+Z never reaches the redo branch.
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !isEditable) {
		return event.shiftKey ? { type: 'redo' } : { type: 'undo' };
	}

	if (isEditable) return null;

	// Shortcuts help sheet
	if (event.key === '?') return { type: 'show-shortcuts' };

	// Move the selected block (Alt+Arrow). Alt (not Cmd/Ctrl) keeps macOS' native
	// word navigation and the browser's history bindings intact, and leaves the
	// plain arrows to the canvas list, which moves the *selection*.
	if (
		(event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
		event.altKey &&
		ctx.hasActiveBlock
	) {
		return { type: 'move', direction: event.key === 'ArrowUp' ? 'up' : 'down' };
	}

	if ((event.key === 'Delete' || event.key === 'Backspace') && ctx.hasActiveBlock) {
		return { type: 'delete' };
	}

	if ((event.metaKey || event.ctrlKey) && event.key === 'd' && ctx.hasActiveBlock) {
		return { type: 'duplicate' };
	}

	return null;
}
