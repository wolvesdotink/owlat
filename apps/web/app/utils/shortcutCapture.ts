/**
 * What a keypress means while a row of the shortcuts page is listening for its
 * new key.
 *
 * Pure, and separate from the page, because the interesting rule here is not a
 * rendering one: a chord's SHAPE is part of its command. A single-key command
 * (archive, `g d`, next line) is answered by handlers that drop Cmd/Ctrl/Alt
 * events before they resolve anything and that stand down while a text field
 * has focus; a chord command (⌘, for Settings, ⌘J for the Assistant) is
 * answered by the dispatcher even while typing. So a remap keeps the shape:
 *
 *   - a modifier chord offered to a single-key command is refused. An override
 *     REPLACES a shortcut's chords rather than adding to them, so storing
 *     `mod+e` would take archive's only working key away and hand it a dead one;
 *   - a single key offered to a chord command is refused too: bound to `,`,
 *     Settings would lose the ability to open from a text field, which is the
 *     reason it is a chord.
 *
 * Tab never becomes a shortcut: it moves focus, and taking it would strand
 * keyboard users, so it ends the capture like Escape and still moves focus on.
 * Neither do the chords the browser or the OS keep for themselves: a page
 * cannot even receive ⌘W or ⌘T, and taking ⌘C or ⌘F would break copying and
 * finding text across the app.
 */

import type { ChordEventLike, ShortcutDefinition } from './shortcutRegistry';
import { chordFromEvent, isModifierChord } from './shortcutRegistry';

export type ShortcutCapture =
	/** A modifier pressed on its own — the user is still reaching for a key. */
	| { kind: 'ignore' }
	/** Escape or Tab — stop listening, change nothing. */
	| { kind: 'cancel' }
	/**
	 * A key this command cannot take: `modifier` (a single-key command was
	 * offered a Cmd/Ctrl/Alt chord), `needsModifier` (a chord command was offered
	 * a single key or an Alt-only chord), `reserved` (a chord the browser or
	 * the OS keeps).
	 */
	| { kind: 'refuse'; reason: 'modifier' | 'needsModifier' | 'reserved' }
	/** Store this. */
	| { kind: 'chord'; chord: string };

/** Modifier presses on their own are the user reaching for a chord, not a key. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'OS']);

/**
 * Chords the browser or the OS answers before (or instead of) the page:
 * clipboard and editing, find, print, save, reload, zoom, and the tab/window
 * keys a page never even receives.
 */
const RESERVED_CHORDS = new Set([
	'mod+a',
	'mod+c',
	'mod+v',
	'mod+x',
	'mod+z',
	'mod+Z',
	'mod+y',
	'mod+f',
	'mod+g',
	'mod+l',
	'mod+n',
	'mod+N',
	'mod+o',
	'mod+p',
	'mod+q',
	'mod+r',
	'mod+R',
	'mod+s',
	'mod+t',
	'mod+T',
	'mod+w',
	'mod+W',
	'mod+0',
	'mod+=',
	'mod+-',
	'mod++',
]);

/** True for a command whose shipped chord holds Cmd/Ctrl or Alt. */
export function expectsModifierChord(def: Pick<ShortcutDefinition, 'keys'>): boolean {
	const first = def.keys[0];
	return first !== undefined && isModifierChord(first);
}

/** True when `chord` has the shape `def`'s handlers can answer. */
export function chordFitsShortcut(def: Pick<ShortcutDefinition, 'keys'>, chord: string): boolean {
	return expectsModifierChord(def) === isModifierChord(chord);
}

export function captureShortcutKey(
	event: ChordEventLike,
	def: Pick<ShortcutDefinition, 'keys'> = { keys: [] }
): ShortcutCapture {
	if (MODIFIER_KEYS.has(event.key)) return { kind: 'ignore' };
	if (event.key === 'Escape' || event.key === 'Tab') return { kind: 'cancel' };
	const chord = chordFromEvent(event);
	if (!expectsModifierChord(def)) {
		if (event.metaKey || event.ctrlKey || event.altKey) {
			return { kind: 'refuse', reason: 'modifier' };
		}
		return { kind: 'chord', chord };
	}
	// Alt alone composes characters on most layouts (⌥E is a dead key on a
	// Mac), so a chord command needs Cmd/Ctrl.
	if (!(event.metaKey || event.ctrlKey)) return { kind: 'refuse', reason: 'needsModifier' };
	if (RESERVED_CHORDS.has(chord)) return { kind: 'refuse', reason: 'reserved' };
	return { kind: 'chord', chord };
}
