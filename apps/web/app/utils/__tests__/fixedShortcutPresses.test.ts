/**
 * The presses the fixed listeners answer, and the presses a chord stands for.
 * The remap check asks the same predicates the listeners use, so a chord
 * like ⌘⌥K or ⌘⇧1 cannot pass as free while a fixed listener answers it.
 */
import { describe, expect, it } from 'vitest';
import { fixedShortcutListenerFor, shortcutPressesForChord } from '../fixedShortcutConflicts';
import { commandPalettePress, sidebarJumpSlot, workspaceSwitchSlot } from '../fixedShortcutPresses';

describe('the listeners’ own predicates', () => {
	it('lets the palette take Cmd/Ctrl+K with Alt held too', () => {
		expect(commandPalettePress({ key: 'k', ctrlKey: true })).toBe('toggle');
		expect(commandPalettePress({ key: 'k', ctrlKey: true, altKey: true })).toBe('toggle');
		expect(commandPalettePress({ key: 'K', metaKey: true, shiftKey: true })).toBe('ask');
		expect(commandPalettePress({ key: 'k' })).toBeNull();
	});

	it('reads the digit row by position, with or without Shift', () => {
		expect(workspaceSwitchSlot({ key: '!', ctrlKey: true, shiftKey: true, code: 'Digit1' })).toBe(
			1
		);
		expect(workspaceSwitchSlot({ key: '&', ctrlKey: true, code: 'Digit1' })).toBe(1);
		expect(
			workspaceSwitchSlot({ key: '1', ctrlKey: true, altKey: true, code: 'Digit1' })
		).toBeNull();
		expect(sidebarJumpSlot({ key: '¡', altKey: true, code: 'Digit1' })).toBe(1);
		expect(sidebarJumpSlot({ key: '1', altKey: true, ctrlKey: true, code: 'Digit1' })).toBeNull();
	});
});

describe('shortcutPressesForChord', () => {
	it('gives a letter its Shift from its case', () => {
		expect(shortcutPressesForChord('mod+alt+k')).toEqual([
			{ key: 'k', ctrlKey: true, altKey: true, shiftKey: false, code: undefined },
		]);
	});

	it('places a digit and a US-shifted digit on the digit row, Shift unknown', () => {
		const presses = shortcutPressesForChord('mod+!');
		expect(presses.map((press) => press.code)).toEqual(['Digit1', 'Digit1']);
		expect(presses.map((press) => press.shiftKey)).toEqual([false, true]);
		expect(shortcutPressesForChord('mod+3')[0]?.code).toBe('Digit3');
	});

	it('is empty for an unparseable chord', () => {
		expect(shortcutPressesForChord('hyper+x')).toEqual([]);
	});
});

describe('fixedShortcutListenerFor', () => {
	const owner = (chord: string) => fixedShortcutListenerFor(shortcutPressesForChord(chord));

	it('names the listener a loose variant of its chord reaches', () => {
		expect(owner('mod+alt+k')).toBe('global.commandPalette');
		expect(owner('mod+alt+K')).toBe('global.ask');
		expect(owner('mod+!')).toBe('workspace.switch');
		expect(owner('mod+(')).toBe('workspace.switch');
		expect(owner('mod+alt+Enter')).toBe('composer.send');
	});

	it('leaves chords no fixed listener answers alone', () => {
		expect(owner('mod+,')).toBeNull();
		expect(owner('mod+.')).toBeNull();
		expect(owner('mod+alt+j')).toBeNull();
	});

	it('skips the shortcut being remapped', () => {
		expect(
			fixedShortcutListenerFor(shortcutPressesForChord('mod+k'), 'global.commandPalette')
		).toBeNull();
	});
});
