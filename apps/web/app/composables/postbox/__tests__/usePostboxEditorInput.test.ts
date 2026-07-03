import { describe, it, expect, vi } from 'vitest';
import { usePostboxEditorInput, type PostboxEditorInputDeps } from '../usePostboxEditorInput';

function makeDeps(over: Partial<PostboxEditorInputDeps> = {}) {
	const deps: PostboxEditorInputDeps = {
		handleBeforeInput: vi.fn(() => false),
		handleShortcutUndoKeydown: vi.fn(() => false),
		handleFormatKeydown: vi.fn(),
		emitContent: vi.fn(),
		emoji: { handleKeydown: vi.fn(() => false) },
		ghost: { hasGhost: vi.fn(() => false), accept: vi.fn(), cancel: vi.fn() },
		rewrite: { invalidateOnEdit: vi.fn(), handleEscape: vi.fn(() => false) },
		...over,
	};
	return deps;
}

function keydown(key: string) {
	return new KeyboardEvent('keydown', { key, cancelable: true });
}

describe('usePostboxEditorInput', () => {
	it('onBeforeInput emits + invalidates only when the input was consumed', () => {
		const consumed = makeDeps({ handleBeforeInput: vi.fn(() => true) });
		usePostboxEditorInput(consumed).onBeforeInput(new InputEvent('beforeinput'));
		expect(consumed.emitContent).toHaveBeenCalledTimes(1);
		expect(consumed.rewrite.invalidateOnEdit).toHaveBeenCalledTimes(1);

		const passthrough = makeDeps();
		usePostboxEditorInput(passthrough).onBeforeInput(new InputEvent('beforeinput'));
		expect(passthrough.emitContent).not.toHaveBeenCalled();
		expect(passthrough.rewrite.invalidateOnEdit).not.toHaveBeenCalled();
	});

	it('an open emoji picker owns the keystroke (short-circuits everything)', () => {
		const deps = makeDeps({ emoji: { handleKeydown: vi.fn(() => true) } });
		usePostboxEditorInput(deps).onKeydown(keydown('Enter'));
		expect(deps.handleShortcutUndoKeydown).not.toHaveBeenCalled();
		expect(deps.ghost.hasGhost).not.toHaveBeenCalled();
		expect(deps.handleFormatKeydown).not.toHaveBeenCalled();
	});

	it('a one-shot undo emits and stops before format handling', () => {
		const deps = makeDeps({ handleShortcutUndoKeydown: vi.fn(() => true) });
		usePostboxEditorInput(deps).onKeydown(keydown('z'));
		expect(deps.emitContent).toHaveBeenCalledTimes(1);
		expect(deps.handleFormatKeydown).not.toHaveBeenCalled();
	});

	it('Tab accepts ghost text and prevents default', () => {
		const deps = makeDeps({
			ghost: { hasGhost: vi.fn(() => true), accept: vi.fn(), cancel: vi.fn() },
		});
		const e = keydown('Tab');
		usePostboxEditorInput(deps).onKeydown(e);
		expect(deps.ghost.accept).toHaveBeenCalledTimes(1);
		expect(e.defaultPrevented).toBe(true);
		expect(deps.handleFormatKeydown).not.toHaveBeenCalled();
	});

	it('a non-Tab/Esc key dismisses a pending ghost then continues to format', () => {
		const deps = makeDeps({
			ghost: { hasGhost: vi.fn(() => true), accept: vi.fn(), cancel: vi.fn() },
		});
		usePostboxEditorInput(deps).onKeydown(keydown('a'));
		expect(deps.ghost.cancel).toHaveBeenCalledTimes(1);
		expect(deps.handleFormatKeydown).toHaveBeenCalledTimes(1);
	});

	it('Escape dismisses a rewrite pill when there is no ghost', () => {
		const deps = makeDeps({ rewrite: { invalidateOnEdit: vi.fn(), handleEscape: vi.fn(() => true) } });
		const e = keydown('Escape');
		usePostboxEditorInput(deps).onKeydown(e);
		expect(e.defaultPrevented).toBe(true);
		expect(deps.handleFormatKeydown).not.toHaveBeenCalled();
	});

	it('falls through to format shortcuts when nothing else claims the key', () => {
		const deps = makeDeps();
		usePostboxEditorInput(deps).onKeydown(keydown('b'));
		expect(deps.handleFormatKeydown).toHaveBeenCalledTimes(1);
	});
});
