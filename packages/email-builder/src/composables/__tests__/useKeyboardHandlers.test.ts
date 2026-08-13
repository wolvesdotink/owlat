// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { computed, ref } from 'vue';
import { useKeyboardHandlers, type KeyboardHandlerCallbacks } from '../useKeyboardHandlers';
import { EDITOR_SHORTCUTS, formatShortcut, formatShortcutKeys } from '../editorShortcuts';
import type { EditorBlock } from '../../types';

function imageBlock(id = 'b1'): EditorBlock {
	return { id, type: 'image', content: { src: '', alt: '', width: 100, align: 'center' } };
}

function textBlock(id = 'b1'): EditorBlock {
	return {
		id,
		type: 'text',
		content: { html: '<p>hi</p>', blockType: 'paragraph', fontSize: 16, textColor: '#000' },
	};
}

function setup(options: { selectedBlock?: EditorBlock | null } = {}) {
	const callbacks: KeyboardHandlerCallbacks = {
		onUndo: vi.fn(),
		onRedo: vi.fn(),
		onCloseSlashMenu: vi.fn(),
		onCloseVariablePicker: vi.fn(),
		onCloseSavedBlockPicker: vi.fn(),
		onDeleteSelectedContainerItem: vi.fn(),
		onClearImageContent: vi.fn(),
		onDuplicateSelectedContainerItem: vi.fn(),
		onMoveSelection: vi.fn(),
		onInsertColumnItemAfter: vi.fn(() => null),
		onInsertEmptyTextBlockAfter: vi.fn(() => textBlock('new')),
		onFocusTextEditor: vi.fn(),
		onFocusColumnItemTextEditor: vi.fn(),
	};

	const handlers = useKeyboardHandlers({
		menuState: computed(() => ({
			isSlashMenuOpen: false,
			isVariablePickerOpen: false,
			isSavedBlockPickerOpen: false,
		})),
		selectedBlock: computed(() => options.selectedBlock ?? null),
		selectedColumnItem: computed(() => null),
		selectedColumnContext: ref(null),
		selectedContainerItem: computed(() => null),
		selectedContainerContext: ref(null),
		callbacks,
	});

	return { handlers, callbacks };
}

describe('useKeyboardHandlers — undo/redo', () => {
	it('redoes on Cmd/Ctrl+Shift+Z (event.key is uppercased by Shift)', () => {
		const { handlers, callbacks } = setup();
		const event = new KeyboardEvent('keydown', { key: 'Z', metaKey: true, shiftKey: true });
		handlers.handleUndoRedoKeydown(event);
		expect(callbacks.onRedo).toHaveBeenCalledTimes(1);
		expect(callbacks.onUndo).not.toHaveBeenCalled();
	});

	it('undoes on Cmd/Ctrl+Z', () => {
		const { handlers, callbacks } = setup();
		handlers.handleUndoRedoKeydown(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
		expect(callbacks.onUndo).toHaveBeenCalledTimes(1);
		expect(callbacks.onRedo).not.toHaveBeenCalled();
	});
});

describe('useKeyboardHandlers — Alt+Arrow reorder', () => {
	it('moves the selected block up on Alt+ArrowUp', () => {
		const { handlers, callbacks } = setup({ selectedBlock: imageBlock() });
		const event = new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, cancelable: true });
		handlers.handleKeydown(event);
		expect(callbacks.onMoveSelection).toHaveBeenCalledWith('up');
		expect(event.defaultPrevented).toBe(true);
	});

	it('moves the selected block down on Alt+ArrowDown', () => {
		const { handlers, callbacks } = setup({ selectedBlock: imageBlock() });
		handlers.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }));
		expect(callbacks.onMoveSelection).toHaveBeenCalledWith('down');
	});

	it('ignores plain arrows without Alt', () => {
		const { handlers, callbacks } = setup({ selectedBlock: imageBlock() });
		handlers.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
		expect(callbacks.onMoveSelection).not.toHaveBeenCalled();
	});

	it('does nothing when nothing is selected', () => {
		const { handlers, callbacks } = setup({ selectedBlock: null });
		handlers.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true }));
		expect(callbacks.onMoveSelection).not.toHaveBeenCalled();
	});

	it('does not hijack arrows while typing in an input', () => {
		const { handlers, callbacks } = setup({ selectedBlock: imageBlock() });
		const input = document.createElement('input');
		document.body.appendChild(input);
		const event = new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true });
		Object.defineProperty(event, 'target', { value: input });
		handlers.handleKeydown(event);
		expect(callbacks.onMoveSelection).not.toHaveBeenCalled();
		input.remove();
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
