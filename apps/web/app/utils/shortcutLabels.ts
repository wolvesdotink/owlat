/**
 * Shortcut chords as a person reads them inline (a menu row, a tooltip, a
 * palette hint) and as assistive technology reads them (`aria-keyshortcuts`).
 *
 * The cheat sheets print a chord as separate `<kbd>` tokens (`formatChord`);
 * everything else wants ONE string, and it has to be right for the machine:
 * `⌘K` on a Mac, `Ctrl+K` everywhere else. Spelling those strings by hand is
 * how a Windows user ended up being told to press ⌘K. Pure, so the
 * platform matrix is unit-tested without a browser.
 */

import type { ShortcutBindings, ShortcutDefinition, ShortcutScope } from './shortcutRegistry';
import { chordSteps, formatChord, resolveShortcutId } from './shortcutRegistry';

/** macOS writes modifiers as glyphs, in the fixed order its menus use. */
const MAC_MODIFIER_GLYPHS: Readonly<Record<string, string>> = {
	alt: '⌥',
	shift: '⇧',
	mod: '⌘',
};
const MAC_MODIFIER_ORDER = ['alt', 'shift', 'mod'] as const;
const PC_MODIFIER_NAMES: Readonly<Record<string, string>> = {
	mod: 'Ctrl',
	alt: 'Alt',
	shift: 'Shift',
};
const PC_MODIFIER_ORDER = ['mod', 'alt', 'shift'] as const;

/** `aria-keyshortcuts` modifier names (WAI-ARIA, UI Events key values). */
const ARIA_MODIFIER_NAMES = (isMac: boolean): Readonly<Record<string, string>> => ({
	mod: isMac ? 'Meta' : 'Control',
	alt: 'Alt',
	shift: 'Shift',
});

interface ParsedStep {
	mods: Set<string>;
	key: string;
}

/**
 * One normalized step split into modifiers and key. A printable capital letter
 * carries Shift in its case (`U` is Shift+U, see `chordFromEvent`), which an
 * inline label has to say out loud: printed as a keycap, `U` and `u` look
 * the same.
 */
function parseStep(step: string): ParsedStep {
	const parts = step === '+' ? ['+'] : step.split('+');
	const key = parts.pop() as string;
	const mods = new Set(parts);
	if (/^[A-Z]$/.test(key)) mods.add('shift');
	return { mods, key };
}

/** The key as a keycap: letters in capitals, named keys as `formatChord` prints them. */
function keycap(key: string, isMac: boolean): string {
	if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase();
	if (key === 'Enter' && isMac) return '↵';
	// formatChord owns the glyph table (arrows, Esc, Del, ⌫).
	return formatChord(key, isMac).at(-1) ?? key;
}

/**
 * One chord as a single inline label: `⌘K` / `Ctrl+K`, `⇧⌘F` /
 * `Ctrl+Shift+F`, `E`, `⇧U` / `Shift+U`. Sequence steps are separated by a
 * space (`G I`). Empty for a chord that cannot be parsed.
 */
export function formatChordLabel(chord: string, isMac: boolean): string {
	return chordSteps(chord)
		.map((step) => {
			const { mods, key } = parseStep(step);
			const cap = keycap(key, isMac);
			if (isMac) {
				return MAC_MODIFIER_ORDER.filter((m) => mods.has(m))
					.map((m) => MAC_MODIFIER_GLYPHS[m])
					.concat(cap)
					.join('');
			}
			return PC_MODIFIER_ORDER.filter((m) => mods.has(m))
				.map((m) => PC_MODIFIER_NAMES[m])
				.concat(cap)
				.join('+');
		})
		.join(' ');
}

/**
 * One chord as an `aria-keyshortcuts` token, or `null` when the attribute
 * cannot express it. The attribute has no notation for a key SEQUENCE (a
 * space separates alternatives), so `g i` is left out rather than announced as
 * two unrelated shortcuts.
 */
export function chordAriaKeyShortcut(chord: string, isMac: boolean): string | null {
	const steps = chordSteps(chord);
	if (steps.length !== 1) return null;
	const { mods, key } = parseStep(steps[0] as string);
	const names = ARIA_MODIFIER_NAMES(isMac);
	// '+' is the token's own separator and a space separates tokens, so both
	// keys have names in the attribute's grammar.
	const ariaKey = key === '+' ? 'Plus' : key;
	return PC_MODIFIER_ORDER.filter((m) => mods.has(m))
		.map((m) => names[m])
		.concat(ariaKey)
		.join('+');
}

/** Every chord that can be announced, as one `aria-keyshortcuts` value. */
export function chordsAriaKeyShortcuts(
	chords: readonly string[],
	isMac: boolean
): string | undefined {
	const tokens = chords
		.map((chord) => chordAriaKeyShortcut(chord, isMac))
		.filter((token): token is string => token !== null);
	return tokens.length > 0 ? tokens.join(' ') : undefined;
}

/**
 * The chords that really fire `id` right now, canonical first.
 *
 * Empty for an unknown id, an id a preset or the user unbound, and a chord a
 * nearer scope has taken over (in the Postbox `n` is "next unread", so
 * "New item" must not advertise it there). An id whose own scope is not
 * claimed at the moment is judged inside that scope alone: its hint describes
 * the surface it belongs to, not whatever happens to be mounted.
 */
export function liveShortcutChords(
	definitions: readonly ShortcutDefinition[],
	bindings: ShortcutBindings,
	id: string,
	activeScopes: readonly ShortcutScope[]
): string[] {
	const def = definitions.find((entry) => entry.id === id);
	if (!def) return [];
	const scopes = activeScopes.includes(def.scope) ? activeScopes : [def.scope];
	return (bindings.byId.get(id) ?? []).filter(
		(chord) => resolveShortcutId(bindings, chord, scopes) === id
	);
}

/**
 * The inline label for `id`, or `null` when nothing fires it right now. An
 * entry that summarizes a family of chords (`displayKeys`, e.g. `⌘1–9`) is
 * labelled by that summary rather than by its first member.
 */
export function shortcutLabel(
	definitions: readonly ShortcutDefinition[],
	bindings: ShortcutBindings,
	id: string,
	activeScopes: readonly ShortcutScope[],
	isMac: boolean
): string | null {
	const live = liveShortcutChords(definitions, bindings, id, activeScopes);
	if (live.length === 0) return null;
	const def = definitions.find((entry) => entry.id === id);
	return formatChordLabel(def?.displayKeys ?? (live[0] as string), isMac) || null;
}
