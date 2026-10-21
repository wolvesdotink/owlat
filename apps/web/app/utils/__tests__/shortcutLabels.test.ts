import { describe, expect, it } from 'vitest';
import {
	chordAriaKeyShortcut,
	chordsAriaKeyShortcuts,
	formatChordLabel,
	liveShortcutChords,
	shortcutLabel,
} from '../shortcutLabels';
import { buildShortcutBindings } from '../shortcutRegistry';
import { SHORTCUT_CATALOG } from '../shortcutCatalog';
import { SHORTCUT_PRESETS } from '../shortcutPresets';

/**
 * Inline shortcut labels and `aria-keyshortcuts` values: the one place a chord
 * becomes the text a person (or a screen reader) is told to press.
 */
describe('formatChordLabel', () => {
	it.each([
		['mod+k', '⌘K', 'Ctrl+K'],
		['mod+shift+F', '⇧⌘F', 'Ctrl+Shift+F'],
		['mod+Enter', '⌘↵', 'Ctrl+Enter'],
		['mod+,', '⌘,', 'Ctrl+,'],
		['alt+shift+ArrowUp', '⌥⇧↑', 'Alt+Shift+↑'],
		['mod+\\', '⌘\\', 'Ctrl+\\'],
	])('spells %s as %s on a Mac and %s elsewhere', (chord, mac, pc) => {
		expect(formatChordLabel(chord, true)).toBe(mac);
		expect(formatChordLabel(chord, false)).toBe(pc);
	});

	it('prints a bare letter as its keycap, and says Shift for a capital', () => {
		expect(formatChordLabel('e', false)).toBe('E');
		expect(formatChordLabel('U', false)).toBe('Shift+U');
		expect(formatChordLabel('U', true)).toBe('⇧U');
	});

	it('keeps punctuation and named keys as the cheat sheet prints them', () => {
		expect(formatChordLabel('?', false)).toBe('?');
		expect(formatChordLabel('/', true)).toBe('/');
		expect(formatChordLabel('Escape', false)).toBe('Esc');
		expect(formatChordLabel('Delete', true)).toBe('Del');
		expect(formatChordLabel('Enter', false)).toBe('Enter');
	});

	it('separates the steps of a sequence', () => {
		expect(formatChordLabel('g i', false)).toBe('G I');
	});

	it('is empty for a chord that cannot be parsed', () => {
		expect(formatChordLabel('hyper+x', false)).toBe('');
	});
});

describe('chordAriaKeyShortcut', () => {
	it('names the platform modifier the way ARIA does', () => {
		expect(chordAriaKeyShortcut('mod+k', true)).toBe('Meta+k');
		expect(chordAriaKeyShortcut('mod+k', false)).toBe('Control+k');
		expect(chordAriaKeyShortcut('mod+shift+F', false)).toBe('Control+Shift+F');
	});

	it('spells out the Shift a capital letter carries', () => {
		expect(chordAriaKeyShortcut('U', false)).toBe('Shift+U');
		expect(chordAriaKeyShortcut('e', false)).toBe('e');
	});

	it('names the two keys the attribute grammar reserves', () => {
		expect(chordAriaKeyShortcut('Space', false)).toBe('Space');
		expect(chordAriaKeyShortcut('+', false)).toBe('Plus');
	});

	it('leaves out a sequence, which the attribute cannot express', () => {
		expect(chordAriaKeyShortcut('g i', false)).toBeNull();
		expect(chordsAriaKeyShortcuts(['g i'], false)).toBeUndefined();
	});

	it('joins alternatives with a space', () => {
		expect(chordsAriaKeyShortcuts(['#', 'Delete', 'Backspace'], false)).toBe('# Delete Backspace');
	});
});

describe('liveShortcutChords / shortcutLabel', () => {
	const shipped = buildShortcutBindings(SHORTCUT_CATALOG);

	it('labels an id by its first live chord', () => {
		expect(shortcutLabel(SHORTCUT_CATALOG, shipped, 'postbox.archive', ['global'], false)).toBe(
			'E'
		);
		expect(
			shortcutLabel(SHORTCUT_CATALOG, shipped, 'global.commandPalette', ['global'], true)
		).toBe('⌘K');
	});

	it('follows a preset: Superhuman moves reply-all and forward behind Shift', () => {
		const superhuman = buildShortcutBindings(SHORTCUT_CATALOG, [SHORTCUT_PRESETS.superhuman]);
		expect(shortcutLabel(SHORTCUT_CATALOG, shipped, 'postbox.replyAll', ['global'], false)).toBe(
			'A'
		);
		expect(shortcutLabel(SHORTCUT_CATALOG, superhuman, 'postbox.replyAll', ['global'], false)).toBe(
			'Shift+R'
		);
		expect(shortcutLabel(SHORTCUT_CATALOG, superhuman, 'postbox.forward', ['global'], true)).toBe(
			'⇧F'
		);
	});

	it('follows a user remap, and has nothing to say once a key is unbound', () => {
		const remapped = buildShortcutBindings(SHORTCUT_CATALOG, [{ 'postbox.archive': ['y'] }]);
		expect(shortcutLabel(SHORTCUT_CATALOG, remapped, 'postbox.archive', ['global'], false)).toBe(
			'Y'
		);
		const gmail = buildShortcutBindings(SHORTCUT_CATALOG, [SHORTCUT_PRESETS.gmail]);
		expect(liveShortcutChords(SHORTCUT_CATALOG, gmail, 'postbox.toggleBrowse', ['global'])).toEqual(
			[]
		);
		expect(
			shortcutLabel(SHORTCUT_CATALOG, gmail, 'postbox.toggleBrowse', ['global'], false)
		).toBeNull();
	});

	it('does not advertise a key the surface on screen has taken over', () => {
		// The Postbox claims `n` (next unread) and `g s` (Starred).
		expect(liveShortcutChords(SHORTCUT_CATALOG, shipped, 'global.newItem', ['global'])).toEqual([
			'n',
		]);
		expect(
			liveShortcutChords(SHORTCUT_CATALOG, shipped, 'global.newItem', ['postbox', 'global'])
		).toEqual([]);
		expect(
			shortcutLabel(SHORTCUT_CATALOG, shipped, 'global.goToAdmin', ['postbox', 'global'], false)
		).toBeNull();
	});

	it('judges an id whose scope is not claimed inside that scope alone', () => {
		expect(
			liveShortcutChords(SHORTCUT_CATALOG, shipped, 'postbox.nextUnread', ['answer', 'global'])
		).toEqual(['n']);
	});

	it('labels a summarized family by its summary', () => {
		expect(
			shortcutLabel(SHORTCUT_CATALOG, shipped, 'workspace.switch', ['workspace', 'global'], true)
		).toBe('⌘1–9');
	});

	it('has nothing for an id the catalog does not know', () => {
		expect(shortcutLabel(SHORTCUT_CATALOG, shipped, 'global.nope', ['global'], false)).toBeNull();
	});
});
