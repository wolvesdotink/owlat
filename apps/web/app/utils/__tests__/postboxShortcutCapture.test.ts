import { describe, it, expect } from 'vitest';
import { captureShortcutKey } from '../postboxShortcutCapture';

function event(key: string, init: Partial<KeyboardEvent> = {}) {
	return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init };
}

describe('captureShortcutKey', () => {
	it('waits while the user is only holding a modifier down', () => {
		for (const key of ['Shift', 'Control', 'Alt', 'Meta']) {
			expect(captureShortcutKey(event(key, { shiftKey: true }))).toEqual({ kind: 'ignore' });
		}
	});

	it('cancels on Escape rather than binding Esc to something', () => {
		expect(captureShortcutKey(event('Escape'))).toEqual({ kind: 'cancel' });
	});

	it('stores the character the keyboard produced, so U and u stay different', () => {
		expect(captureShortcutKey(event('u'))).toEqual({ kind: 'chord', chord: 'u' });
		expect(captureShortcutKey(event('U', { shiftKey: true }))).toEqual({
			kind: 'chord',
			chord: 'U',
		});
	});

	it('refuses a modifier chord instead of replacing a live key with a dead one', () => {
		// No dispatch path resolves these: the app-wide dispatcher, the thread
		// list and the reader all bail out on Cmd/Ctrl/Alt before they resolve.
		// Storing `mod+e` would take archive's working `e` away for nothing.
		expect(captureShortcutKey(event('e', { ctrlKey: true }))).toEqual({
			kind: 'refuse',
			reason: 'modifier',
		});
		expect(captureShortcutKey(event('e', { metaKey: true }))).toEqual({
			kind: 'refuse',
			reason: 'modifier',
		});
		expect(captureShortcutKey(event('e', { altKey: true }))).toEqual({
			kind: 'refuse',
			reason: 'modifier',
		});
	});

	it('refuses ⌘K, which would always open the command palette instead', () => {
		expect(captureShortcutKey(event('k', { metaKey: true }))).toEqual({
			kind: 'refuse',
			reason: 'modifier',
		});
	});
});
