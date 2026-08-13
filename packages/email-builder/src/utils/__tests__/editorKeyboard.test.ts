// @vitest-environment happy-dom
//
// The editor's global keydown routing — the real one EmailBuilder dispatches on.
import { describe, it, expect } from 'vitest';
import { resolveEditorKeyAction, type EditorKeyContext } from '../editorKeyboard';
import {
	EDITOR_SHORTCUTS,
	formatShortcut,
	formatShortcutKeys,
} from '../../composables/editorShortcuts';

const ctx = (overrides: Partial<EditorKeyContext> = {}): EditorKeyContext => ({
	isInlineEditing: false,
	isShortcutsDialogOpen: false,
	hasActiveBlock: true,
	...overrides,
});

function key(init: KeyboardEventInit, target?: HTMLElement): KeyboardEvent {
	const event = new KeyboardEvent('keydown', init);
	if (target) Object.defineProperty(event, 'target', { value: target });
	return event;
}

describe('resolveEditorKeyAction — undo/redo', () => {
	it('redoes on Cmd/Ctrl+Shift+Z (event.key is uppercased by Shift)', () => {
		expect(resolveEditorKeyAction(key({ key: 'Z', metaKey: true, shiftKey: true }), ctx())).toEqual(
			{
				type: 'redo',
			}
		);
	});

	it('undoes on Cmd/Ctrl+Z', () => {
		expect(resolveEditorKeyAction(key({ key: 'z', ctrlKey: true }), ctx())).toEqual({
			type: 'undo',
		});
	});

	it('leaves undo to the field while typing in one', () => {
		const input = document.createElement('input');
		expect(resolveEditorKeyAction(key({ key: 'z', metaKey: true }, input), ctx())).toBeNull();
	});
});

describe('resolveEditorKeyAction — Alt+Arrow reorder', () => {
	it('moves the selection up and down', () => {
		expect(resolveEditorKeyAction(key({ key: 'ArrowUp', altKey: true }), ctx())).toEqual({
			type: 'move',
			direction: 'up',
		});
		expect(resolveEditorKeyAction(key({ key: 'ArrowDown', altKey: true }), ctx())).toEqual({
			type: 'move',
			direction: 'down',
		});
	});

	it('ignores plain arrows — those belong to the canvas list selection', () => {
		expect(resolveEditorKeyAction(key({ key: 'ArrowUp' }), ctx())).toBeNull();
	});

	it('does nothing when nothing is selected', () => {
		expect(
			resolveEditorKeyAction(key({ key: 'ArrowUp', altKey: true }), ctx({ hasActiveBlock: false }))
		).toBeNull();
	});

	it('does not hijack arrows typed in an input', () => {
		const input = document.createElement('input');
		expect(resolveEditorKeyAction(key({ key: 'ArrowUp', altKey: true }, input), ctx())).toBeNull();
	});

	it('does not hijack arrows typed in a contenteditable', () => {
		const editable = document.createElement('div');
		editable.setAttribute('contenteditable', 'true');
		document.body.appendChild(editable);
		expect(
			resolveEditorKeyAction(key({ key: 'ArrowUp', altKey: true }, editable), ctx())
		).toBeNull();
		editable.remove();
	});
});

describe('resolveEditorKeyAction — block keys', () => {
	it('deletes on Delete and Backspace', () => {
		expect(resolveEditorKeyAction(key({ key: 'Delete' }), ctx())).toEqual({ type: 'delete' });
		expect(resolveEditorKeyAction(key({ key: 'Backspace' }), ctx())).toEqual({ type: 'delete' });
	});

	it('duplicates on Cmd/Ctrl+D', () => {
		expect(resolveEditorKeyAction(key({ key: 'd', metaKey: true }), ctx())).toEqual({
			type: 'duplicate',
		});
	});

	it('opens the help sheet on ?', () => {
		expect(resolveEditorKeyAction(key({ key: '?' }), ctx())).toEqual({ type: 'show-shortcuts' });
	});

	it('needs a selection for the block keys', () => {
		const empty = ctx({ hasActiveBlock: false });
		expect(resolveEditorKeyAction(key({ key: 'Delete' }), empty)).toBeNull();
		expect(resolveEditorKeyAction(key({ key: 'd', metaKey: true }), empty)).toBeNull();
	});
});

describe('resolveEditorKeyAction — modal and inline-edit guards', () => {
	it('leaves inline editing on Escape before anything else', () => {
		expect(resolveEditorKeyAction(key({ key: 'Escape' }), ctx({ isInlineEditing: true }))).toEqual({
			type: 'exit-inline-edit',
		});
	});

	it('ignores Escape when nothing is being edited inline', () => {
		expect(resolveEditorKeyAction(key({ key: 'Escape' }), ctx())).toBeNull();
	});

	it('keeps block keys off the canvas behind the shortcuts sheet', () => {
		const open = ctx({ isShortcutsDialogOpen: true });
		expect(resolveEditorKeyAction(key({ key: 'Delete' }), open)).toBeNull();
		expect(resolveEditorKeyAction(key({ key: 'ArrowDown', altKey: true }), open)).toBeNull();
		expect(resolveEditorKeyAction(key({ key: 'z', metaKey: true }), open)).toBeNull();
	});
});

describe('editorShortcuts registry', () => {
	it('registers the block move and redo shortcuts', () => {
		const descriptions = EDITOR_SHORTCUTS.map((shortcut) => shortcut.description);
		expect(descriptions).toContain('Move selected block up');
		expect(descriptions).toContain('Move selected block down');
		expect(descriptions).toContain('Redo');
	});

	it('binds the move shortcuts to Alt+Arrow', () => {
		const up = EDITOR_SHORTCUTS.find((s) => s.description === 'Move selected block up');
		const down = EDITOR_SHORTCUTS.find((s) => s.description === 'Move selected block down');
		expect(up?.keys).toEqual(['Alt', '↑']);
		expect(down?.keys).toEqual(['Alt', '↓']);
	});

	it('substitutes the platform modifier for the Mod token', () => {
		expect(formatShortcutKeys(['Mod', 'Shift', 'Z'], true)).toEqual(['⌘', 'Shift', 'Z']);
		expect(formatShortcut(['Mod', 'Shift', 'Z'], false)).toBe('Ctrl + Shift + Z');
	});

	it('assigns every shortcut to a known group', () => {
		for (const shortcut of EDITOR_SHORTCUTS) {
			expect(['General', 'Blocks', 'Editing']).toContain(shortcut.group);
			expect(shortcut.keys.length).toBeGreaterThan(0);
		}
	});
});
