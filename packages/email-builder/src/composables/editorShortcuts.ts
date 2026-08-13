/**
 * Canonical list of the editor's keyboard shortcuts.
 *
 * Single source of truth for both the help sheet (KeyboardShortcutsDialog) and
 * the button tooltips — anything bound in `utils/editorKeyboard` or the canvas
 * listbox navigation should be listed here so it is discoverable.
 */

import { onMounted, ref, type Ref } from 'vue';

/** Section a shortcut is grouped under in the help sheet. */
export type EditorShortcutGroup = 'General' | 'Blocks' | 'Editing';

export interface EditorShortcut {
	/**
	 * Key tokens rendered as individual `<kbd>` chips. The literal `Mod` token
	 * is substituted with the platform modifier (⌘ on macOS, Ctrl elsewhere) by
	 * `formatShortcutKeys`.
	 */
	keys: string[];
	description: string;
	group: EditorShortcutGroup;
}

export const EDITOR_SHORTCUTS: readonly EditorShortcut[] = [
	{ keys: ['Mod', 'Z'], description: 'Undo', group: 'General' },
	{ keys: ['Mod', 'Shift', 'Z'], description: 'Redo', group: 'General' },
	{ keys: ['Mod', 'Shift', 'F'], description: 'Toggle focus mode', group: 'General' },
	{ keys: ['?'], description: 'Show keyboard shortcuts', group: 'General' },
	{
		keys: ['Esc'],
		description: 'Close menus, exit inline editing or focus mode',
		group: 'General',
	},

	// Canvas listbox navigation, handled by DocumentCanvas (the canvas is a
	// `role="listbox"`, so plain arrows move the selection and Alt+arrows move
	// the block itself).
	{ keys: ['↑'], description: 'Select the block above', group: 'Blocks' },
	{ keys: ['↓'], description: 'Select the block below', group: 'Blocks' },
	{ keys: ['Home'], description: 'Select the first block', group: 'Blocks' },
	{ keys: ['End'], description: 'Select the last block', group: 'Blocks' },
	{ keys: ['Alt', '↑'], description: 'Move selected block up', group: 'Blocks' },
	{ keys: ['Alt', '↓'], description: 'Move selected block down', group: 'Blocks' },
	{ keys: ['Mod', 'D'], description: 'Duplicate selected block', group: 'Blocks' },
	{ keys: ['Delete'], description: 'Delete selected block (clears an image)', group: 'Blocks' },
	{ keys: ['Enter'], description: 'Insert an empty text block below', group: 'Blocks' },

	{ keys: ['/'], description: 'Open the block insert menu', group: 'Editing' },
	{ keys: ['Mod', 'B'], description: 'Bold', group: 'Editing' },
	{ keys: ['Mod', 'I'], description: 'Italic', group: 'Editing' },
	{ keys: ['Mod', 'U'], description: 'Underline', group: 'Editing' },
	{ keys: ['Mod', 'K'], description: 'Insert or edit a link', group: 'Editing' },
];

export const EDITOR_SHORTCUT_GROUPS: readonly EditorShortcutGroup[] = [
	'General',
	'Blocks',
	'Editing',
];

/** True when running on an Apple platform, where `Mod` renders as ⌘. */
export function isApplePlatform(): boolean {
	if (typeof navigator === 'undefined') return false;
	return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
}

/**
 * The platform, resolved after mount.
 *
 * Reading `navigator` while rendering makes the server (always `Ctrl`) and a
 * macOS client (`⌘`) disagree on markup Vue then has to reconcile — a hydration
 * mismatch on every shortcut label and tooltip. Starting at `false` and
 * flipping in `onMounted` keeps the first client render identical to the
 * server's; the labels correct themselves a tick later.
 */
export function useApplePlatform(): Ref<boolean> {
	const isApple = ref(false);
	onMounted(() => {
		isApple.value = isApplePlatform();
	});
	return isApple;
}

/** Replace the `Mod` token with the platform modifier symbol. */
export function formatShortcutKeys(keys: readonly string[], apple = isApplePlatform()): string[] {
	return keys.map((key) => (key === 'Mod' ? (apple ? '⌘' : 'Ctrl') : key));
}

/** Human-readable single-line form, e.g. `⌘ + Shift + Z`. Used for tooltips. */
export function formatShortcut(keys: readonly string[], apple = isApplePlatform()): string {
	return formatShortcutKeys(keys, apple).join(' + ');
}

/** Look up a registered shortcut by its description. */
export function findShortcut(description: string): EditorShortcut | undefined {
	return EDITOR_SHORTCUTS.find((shortcut) => shortcut.description === description);
}
