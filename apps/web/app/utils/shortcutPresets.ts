/**
 * Named keyboard maps, and the user's own remaps on top of one.
 *
 * Split from `shortcutCatalog.ts` so the catalog stays a flat list of what the
 * app does: this file is about DISAGREEING with that list — the presets people
 * arrive from, and the rules for honouring a stored remap safely.
 */

import type { ShortcutOverlay } from './shortcutRegistry';
import { SHORTCUT_CATALOG } from './shortcutCatalog';

/**
 * Named key maps people arrive with. A preset REPLACES a shortcut's chords, so
 * it can free a key as well as claim one (`[]` = documented but unbound) — the
 * only way "Gmail wants `b` for snooze" can coexist with a `b` we already spent.
 *
 * Deliberately small: a preset is a handful of honest differences from the
 * default map, not a second catalog. Everything a preset does not mention keeps
 * its default chord.
 */
export const SHORTCUT_PRESETS = {
	// The shipped map. Already Gmail-shaped, so the interesting presets are the
	// ones that disagree with it.
	owlat: {},
	gmail: {
		// Gmail's snooze is `b`; ours is `h` (Superhuman's). Give `b` up.
		'postbox.snooze': ['b'],
		'postbox.toggleBrowse': [],
	},
	superhuman: {
		// Superhuman puts reply-all and forward behind Shift, leaving `a` and `f`
		// free rather than one keypress from a mail to everybody.
		'postbox.replyAll': ['R'],
		'postbox.forward': ['F'],
	},
	outlook: {
		// Outlook separates "mark read" (`q`) from "mark unread" (`u`) instead of
		// toggling, and flags with Insert.
		'postbox.toggleRead': ['q'],
		'postbox.markUnread': ['u', 'U'],
		'postbox.star': ['Insert', 's'],
	},
} as const satisfies Record<string, ShortcutOverlay>;

export type ShortcutPreset = keyof typeof SHORTCUT_PRESETS;

export const SHORTCUT_PRESET_IDS = Object.keys(SHORTCUT_PRESETS) as ShortcutPreset[];

/** The shipped map — what an untouched settings row means. */
export const SHORTCUT_PRESET_DEFAULT: ShortcutPreset = 'owlat';

/** Coerce a stored (or unknown) preset id to one we actually have. */
export function resolveShortcutPreset(value: string | undefined | null): ShortcutPreset {
	return value && value in SHORTCUT_PRESETS ? (value as ShortcutPreset) : SHORTCUT_PRESET_DEFAULT;
}

/** True when `id` is a shortcut this build knows AND lets the user move. */
export function isRemappableShortcut(id: string): boolean {
	const def = SHORTCUT_CATALOG.find((entry) => entry.id === id);
	return def !== undefined && def.remappable !== false;
}

export interface StoredShortcutOverride {
	id: string;
	keys: string[];
}

/**
 * Turn the stored remap rows into an overlay, dropping anything this build
 * cannot honour: ids that left the catalog, and ids the catalog refuses to
 * move. (Unparseable chords are dropped one layer down, by
 * `buildShortcutBindings`.) A settings row written by a newer client must never
 * take the keyboard down on an older one.
 */
export function shortcutOverridesToOverlay(
	stored: readonly StoredShortcutOverride[] | undefined | null
): ShortcutOverlay {
	const overlay: Record<string, string[]> = {};
	for (const row of stored ?? []) {
		if (!isRemappableShortcut(row.id)) continue;
		overlay[row.id] = row.keys;
	}
	return overlay;
}
