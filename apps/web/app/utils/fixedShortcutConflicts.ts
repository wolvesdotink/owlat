/**
 * The remap check's side of the fixed listeners: which catalog id's own
 * listener would answer a press, and the presses a chord string stands for.
 * Kept apart from the predicates in `fixedShortcutPresses.ts` because those
 * sit on the boot path and this needs the chord parser, which must stay out
 * of the entry bundle.
 */

import { isZenChord } from './zenMode';
import { chordSteps } from './shortcutRegistry';
import type { ShortcutPressLike } from './fixedShortcutPresses';
import {
	commandPalettePress,
	isFolderRailPress,
	isTriageUndoPress,
	sidebarJumpSlot,
	workspaceSwitchSlot,
} from './fixedShortcutPresses';

/**
 * Catalog id → the presses its own listener answers. The composers' send key
 * is answered on the editor element, before the dispatcher sees the press;
 * the loosest of them takes Cmd/Ctrl+Enter with any other modifier.
 */
const FIXED_SHORTCUT_LISTENERS: ReadonlyArray<{
	id: string;
	matches: (press: ShortcutPressLike) => boolean;
}> = [
	{ id: 'global.commandPalette', matches: (press) => commandPalettePress(press) === 'toggle' },
	{ id: 'global.ask', matches: (press) => commandPalettePress(press) === 'ask' },
	{ id: 'global.zen', matches: isZenChord },
	{ id: 'global.jumpToSidebarItem', matches: (press) => sidebarJumpSlot(press) !== null },
	{ id: 'workspace.switch', matches: (press) => workspaceSwitchSlot(press) !== null },
	{ id: 'postbox.toggleRail', matches: isFolderRailPress },
	{ id: 'postbox.undoChord', matches: isTriageUndoPress },
	{
		id: 'composer.send',
		matches: (press) => !!(press.metaKey || press.ctrlKey) && press.key === 'Enter',
	},
];

/** The characters Shift+1…Shift+9 type on a US keyboard. */
const US_SHIFTED_DIGITS = '!@#$%^&*(';

/**
 * The presses that produce a chord's first step. A chord does not say which
 * key position typed it, nor whether Shift was held for a symbol (`!` is
 * Shift+1), so a digit or a US-shifted digit gets its digit-row position and
 * a symbol is tried with and without Shift. The shortcuts page also passes
 * the real press it captured, which carries the position on any layout.
 */
export function shortcutPressesForChord(chord: string): ShortcutPressLike[] {
	const first = chordSteps(chord)[0];
	if (!first) return [];
	const parts = first === '+' ? ['+'] : first.split('+');
	const key = parts.pop() as string;
	const shiftedDigit = US_SHIFTED_DIGITS.indexOf(key);
	const code = /^[1-9]$/.test(key)
		? `Digit${key}`
		: shiftedDigit >= 0
			? `Digit${shiftedDigit + 1}`
			: undefined;
	const base = { key, ctrlKey: parts.includes('mod'), altKey: parts.includes('alt'), code };
	if (/^[a-z]$/i.test(key)) return [{ ...base, shiftKey: key !== key.toLowerCase() }];
	if (key.length > 1) return [{ ...base, shiftKey: parts.includes('shift') }];
	return [
		{ ...base, shiftKey: false },
		{ ...base, shiftKey: true },
	];
}

/**
 * The catalog id whose own listener would answer any of `presses`, other
 * than `exceptId`. Null when none would.
 */
export function fixedShortcutListenerFor(
	presses: readonly ShortcutPressLike[],
	exceptId?: string
): string | null {
	for (const listener of FIXED_SHORTCUT_LISTENERS) {
		if (listener.id !== exceptId && presses.some(listener.matches)) return listener.id;
	}
	return null;
}
