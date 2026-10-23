/**
 * The presses the shortcuts answered OUTSIDE the dispatcher accept, written
 * once and shared by their listeners and by the remap check
 * (`fixedShortcutConflicts.ts`).
 *
 * A catalog chord is exact, but these listeners are not: the palette takes
 * Cmd/Ctrl+K with or without Alt, and the workspace and sidebar jumps read the
 * digit row by position (`event.code`), so Ctrl+Shift+1 (`mod+!` on a US
 * keyboard) switches workspace too. A remap is checked against these
 * predicates rather than the catalog strings; otherwise a chord the check
 * calls free would fire a fixed shortcut on the same press.
 *
 * The command palette's listener is on the boot path (a client plugin attaches
 * it), so everything this module imports lands in the entry bundle, which has
 * a gzip budget (scripts/check-bundle-budget.ts). Keep it free of runtime
 * imports; anything that needs the registry or the catalog belongs in
 * `fixedShortcutConflicts.ts`.
 */

import type { ChordEventLike } from './shortcutRegistry';

/** A keydown as these listeners read it: the chord fields plus the key position. */
export interface ShortcutPressLike extends ChordEventLike {
	code?: string;
}

const hasMod = (press: ShortcutPressLike) => !!(press.metaKey || press.ctrlKey);

/**
 * What a press means to the command palette: Cmd/Ctrl+K toggles it and
 * Cmd/Ctrl+Shift+K opens it on Ask. Alt does not matter.
 */
export function commandPalettePress(press: ShortcutPressLike): 'toggle' | 'ask' | null {
	if (!hasMod(press) || press.key.toLowerCase() !== 'k') return null;
	return press.shiftKey ? 'ask' : 'toggle';
}

/** 1–9 for a digit-row key by position (`event.code`), whatever it types. */
function digitRowSlot(press: ShortcutPressLike): number | null {
	const match = /^Digit([1-9])$/.exec(press.code ?? '');
	return match ? Number(match[1]) : null;
}

/** ⌘1–⌘9 → the workspace slot. Shift is allowed, Alt is not. */
export function workspaceSwitchSlot(press: ShortcutPressLike): number | null {
	if (press.altKey || !hasMod(press)) return null;
	return digitRowSlot(press);
}

/** Alt+1–9 → the sidebar item. Shift is allowed, Cmd/Ctrl is not. */
export function sidebarJumpSlot(press: ShortcutPressLike): number | null {
	if (!press.altKey || hasMod(press)) return null;
	return digitRowSlot(press);
}

/** Cmd/Ctrl+Shift+D, the Postbox folder rail. */
export function isFolderRailPress(press: ShortcutPressLike): boolean {
	return hasMod(press) && !!press.shiftKey && !press.altKey && press.key.toLowerCase() === 'd';
}

/** Cmd/Ctrl+Z with nothing else held, the Postbox triage undo. */
export function isTriageUndoPress(press: ShortcutPressLike): boolean {
	return hasMod(press) && !press.altKey && !press.shiftKey && press.key.toLowerCase() === 'z';
}
