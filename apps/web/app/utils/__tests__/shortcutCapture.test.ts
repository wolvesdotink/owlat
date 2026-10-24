import { describe, it, expect } from 'vitest';
import { captureShortcutKey, chordFitsShortcut, expectsModifierChord } from '../shortcutCapture';
import { SHORTCUT_CATALOG } from '../shortcutCatalog';

function event(key: string, init: Partial<KeyboardEvent> = {}) {
	return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init };
}

const ARCHIVE = { keys: ['e'] };
const SETTINGS = { keys: ['mod+,'] };

describe('captureShortcutKey', () => {
	it('waits while the user is only holding a modifier down', () => {
		for (const key of ['Shift', 'Control', 'Alt', 'Meta']) {
			expect(captureShortcutKey(event(key, { shiftKey: true }), SETTINGS)).toEqual({
				kind: 'ignore',
			});
		}
	});

	it('cancels on Escape rather than binding Esc to something', () => {
		expect(captureShortcutKey(event('Escape'), ARCHIVE)).toEqual({ kind: 'cancel' });
	});

	it('cancels on Tab, which keeps moving focus instead of becoming a shortcut', () => {
		expect(captureShortcutKey(event('Tab'), ARCHIVE)).toEqual({ kind: 'cancel' });
		expect(captureShortcutKey(event('Tab', { shiftKey: true }), SETTINGS)).toEqual({
			kind: 'cancel',
		});
	});

	it('stores the character the keyboard produced, so U and u stay different', () => {
		expect(captureShortcutKey(event('u'), ARCHIVE)).toEqual({ kind: 'chord', chord: 'u' });
		expect(captureShortcutKey(event('U', { shiftKey: true }), ARCHIVE)).toEqual({
			kind: 'chord',
			chord: 'U',
		});
	});

	it('refuses a modifier chord for a single-key command instead of replacing a live key with a dead one', () => {
		// The thread list and the reader bail out on Cmd/Ctrl/Alt before they
		// resolve, so storing `mod+e` would take archive's working `e` away.
		for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
			expect(captureShortcutKey(event('e', init), ARCHIVE)).toEqual({
				kind: 'refuse',
				reason: 'modifier',
			});
		}
	});

	it('takes a Cmd/Ctrl chord for a chord command, spelled the way the dispatcher reads it', () => {
		expect(captureShortcutKey(event('.', { metaKey: true }), SETTINGS)).toEqual({
			kind: 'chord',
			chord: 'mod+.',
		});
		// Shift lives in the letter's case; Caps Lock does not.
		expect(captureShortcutKey(event('j', { ctrlKey: true, shiftKey: true }), SETTINGS)).toEqual({
			kind: 'chord',
			chord: 'mod+J',
		});
		expect(captureShortcutKey(event('J', { ctrlKey: true }), SETTINGS)).toEqual({
			kind: 'chord',
			chord: 'mod+j',
		});
	});

	it('refuses a single key or an Alt-only chord for a chord command', () => {
		// Settings opens from a text field because it is a chord; a bare `,` would not.
		expect(captureShortcutKey(event(','), SETTINGS)).toEqual({
			kind: 'refuse',
			reason: 'needsModifier',
		});
		expect(captureShortcutKey(event('e', { altKey: true }), SETTINGS)).toEqual({
			kind: 'refuse',
			reason: 'needsModifier',
		});
	});

	it('refuses the chords the browser or the OS keeps for themselves', () => {
		for (const key of ['c', 'v', 'f', 'w', 't', 'z']) {
			expect(captureShortcutKey(event(key, { metaKey: true }), SETTINGS)).toEqual({
				kind: 'refuse',
				reason: 'reserved',
			});
		}
		expect(captureShortcutKey(event('z', { ctrlKey: true, shiftKey: true }), SETTINGS)).toEqual({
			kind: 'refuse',
			reason: 'reserved',
		});
	});
});

describe('chord shape', () => {
	it('reads a command as a chord command from its shipped chord', () => {
		expect(expectsModifierChord(SETTINGS)).toBe(true);
		expect(expectsModifierChord(ARCHIVE)).toBe(false);
		expect(expectsModifierChord({ keys: ['g d'] })).toBe(false);
	});

	it('only fits a chord of the same shape', () => {
		expect(chordFitsShortcut(SETTINGS, 'mod+.')).toBe(true);
		expect(chordFitsShortcut(SETTINGS, ',')).toBe(false);
		expect(chordFitsShortcut(ARCHIVE, 'mod+e')).toBe(false);
		expect(chordFitsShortcut(ARCHIVE, 'y')).toBe(true);
	});

	it('ships every remappable command with chords of one shape', () => {
		const mixed = SHORTCUT_CATALOG.filter(
			(def) => def.remappable !== false && def.keys.some((key) => !chordFitsShortcut(def, key))
		);
		expect(mixed.map((def) => def.id)).toEqual([]);
	});
});
