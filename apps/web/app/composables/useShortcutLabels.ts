import { computed, type ComputedRef } from 'vue';
import { readDesktopPlatform } from '~/lib/desktop/platform';
import { SHORTCUT_CATALOG } from '~/utils/shortcutCatalog';
import { activeShortcutScopes, shortcutBindings } from '~/utils/shortcutScope';
import {
	chordsAriaKeyShortcuts,
	formatChordLabel,
	liveShortcutChords,
	shortcutLabel,
} from '~/utils/shortcutLabels';

/**
 * True when shortcut hints should say ⌘ rather than Ctrl.
 *
 * Not `useDesktopContext().isMac`: that one is gated on the desktop RUNTIME,
 * and a browser on a Mac needs the ⌘ just as much. Read from
 * `lib/desktop/platform.ts`, the one module that detects the OS, so these
 * hints can never disagree with the titlebar about which machine this is.
 */
export function useShortcutIsMac(): ComputedRef<boolean> {
	return computed(() => !import.meta.server && readDesktopPlatform() === 'mac');
}

/**
 * The one bridge from the shortcut registry to what a person reads.
 *
 * Every helper reads the live bindings (preset + the user's remaps), the scopes
 * currently claimed and the platform, so a template or computed calling it
 * re-renders when any of them changes: switching to the Superhuman preset
 * moves "Reply all" from `A` to `Shift+R` in an open palette. An id nothing fires
 * right now (unbound, unknown, shadowed by the surface on screen) has no label
 * and no `aria-keyshortcuts`, so no hint ever promises a key that does nothing.
 *
 * `chordLabel`/`chordAria` are for the few fixed chords the registry does not
 * own (a click modifier, an editor's own key); they still get the platform
 * right.
 */
export function useShortcutLabels() {
	const isMac = useShortcutIsMac();

	function labelFor(id: string): string | null {
		return shortcutLabel(
			SHORTCUT_CATALOG,
			shortcutBindings.value,
			id,
			activeShortcutScopes(),
			isMac.value
		);
	}

	function ariaFor(id: string): string | undefined {
		const chords = liveShortcutChords(
			SHORTCUT_CATALOG,
			shortcutBindings.value,
			id,
			activeShortcutScopes()
		);
		return chordsAriaKeyShortcuts(chords, isMac.value);
	}

	function chordLabel(chord: string): string {
		return formatChordLabel(chord, isMac.value);
	}

	function chordAria(chord: string): string | undefined {
		return chordsAriaKeyShortcuts([chord], isMac.value);
	}

	/**
	 * A control's tooltip with its shortcut: `Archive (E)`. Just the name when
	 * nothing fires the id right now.
	 */
	function titleWithShortcut(name: string, id: string): string {
		const label = labelFor(id);
		return label ? `${name} (${label})` : name;
	}

	/**
	 * Message parameters naming keys by catalog id (`{ compose: 'global.compose' }`)
	 * as their labels. Null when any of them fires nothing right now: a sentence
	 * with a blank where the key belongs is worse than no sentence, so the caller
	 * drops the copy (or picks a variant without that key).
	 */
	function labelParams(ids: Readonly<Record<string, string>> = {}): Record<string, string> | null {
		const params: Record<string, string> = {};
		for (const [param, id] of Object.entries(ids)) {
			const label = labelFor(id);
			if (!label) return null;
			params[param] = label;
		}
		return params;
	}

	return { isMac, labelFor, ariaFor, chordLabel, chordAria, titleWithShortcut, labelParams };
}
