/**
 * What a keypress means while a row of the "Keyboard shortcuts" card is
 * listening for its new key.
 *
 * Pure, and separate from the card, because the interesting rule here is not a
 * rendering one: the mailbox vocabulary is SINGLE-KEY by design. Every path
 * that could fire one of these — the app-wide dispatcher, the thread list, the
 * reader's window handler — drops Cmd/Ctrl/Alt events before it resolves
 * anything, leaving those chords to the browser, the OS and ⌘K. And because an
 * override REPLACES a shortcut's chords rather than adding to them, storing
 * `mod+e` would not give archive a second key, it would take its only working
 * one away and hand it a dead one. So a modifier chord is refused at the door
 * rather than saved and quietly ignored.
 */

import type { ChordEventLike } from './shortcutRegistry';
import { chordFromEvent } from './shortcutRegistry';

export type ShortcutCapture =
	/** A modifier pressed on its own — the user is still reaching for a key. */
	| { kind: 'ignore' }
	/** Escape — stop listening, change nothing. */
	| { kind: 'cancel' }
	/** A chord no dispatch path can ever resolve. */
	| { kind: 'refuse'; reason: 'modifier' }
	/** Store this. */
	| { kind: 'chord'; chord: string };

/** Modifier presses on their own are the user reaching for a chord, not a key. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'OS']);

export function captureShortcutKey(event: ChordEventLike): ShortcutCapture {
	if (MODIFIER_KEYS.has(event.key)) return { kind: 'ignore' };
	if (event.key === 'Escape') return { kind: 'cancel' };
	if (event.metaKey || event.ctrlKey || event.altKey) return { kind: 'refuse', reason: 'modifier' };
	return { kind: 'chord', chord: chordFromEvent(event) };
}
