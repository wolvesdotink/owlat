/**
 * The shared spelling of the shortcut catalog modules: group headings, label
 * keys and the reasons a chord is fixed. Its own module so the catalog files
 * that `shortcutCatalog.ts` spreads in can use it without importing the
 * catalog back. The catalog files import these under short local names
 * (`G`, `L`, `CONVENTION`, …); the exported names are long because every
 * `utils/` export is also a Nuxt auto-import.
 */

import type { ShortcutFixedReason } from './shortcutRegistry';

export const SHORTCUT_GROUPS = {
	navigation: 'shared.shortcuts.groups.navigation',
	actions: 'shared.shortcuts.groups.actions',
	general: 'shared.shortcuts.groups.general',
	triage: 'shared.shortcuts.groups.triage',
	organize: 'shared.shortcuts.groups.organize',
	compose: 'shared.shortcuts.groups.compose',
	review: 'shared.shortcuts.groups.review',
	teamInbox: 'shared.shortcuts.groups.teamInbox',
	workbench: 'shared.shortcuts.groups.workbench',
	workspace: 'shared.shortcuts.groups.workspace',
	answer: 'shared.shortcuts.groups.answer',
} as const;

export const shortcutLabelKey = (name: string) => `shared.shortcuts.labels.${name}`;

const fixed = (fixedReason: ShortcutFixedReason) => ({ remappable: false, fixedReason }) as const;

/** A key people expect from every app (Esc, Enter, ⌘Enter, ⌘Z, ⌘K). */
export const FIXED_CONVENTION = fixed('convention');
/** Matched by the key's position, so it works on every keyboard layout. */
export const FIXED_LAYOUT = fixed('layout');
/** Answered by its screen's own handler, which a stored remap never reaches. */
export const FIXED_SURFACE = fixed('surface');
/** The digit is the number of the option it picks. */
export const FIXED_NUMBERED = fixed('numbered');
