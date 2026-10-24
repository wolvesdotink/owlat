/**
 * Feeds the user's keyboard preferences into the shortcut registry, and is the
 * only door through which a remap is allowed in.
 *
 * The registry itself is module state (`utils/shortcutScope.ts`) because its
 * readers are keydown handlers; this composable is the reactive bridge from the
 * `mailUserSettings` row to that state, mounted once by the dashboard layout.
 * Absent settings resolve to the shipped map, so the keyboard is correct from
 * the first frame and simply sharpens when the query lands.
 *
 * A remap is REFUSED rather than merged when it would make two shortcuts in one
 * scope answer the same chord. `buildShortcutBindings` survives a conflict (a
 * broken shortcut must not take the rest of the keyboard down), but there is no
 * reason to persist one: the picker can tell the user which shortcut is in the
 * way before anything is written.
 */

import { buildShortcutBindings, normalizeChord } from '~/utils/shortcutRegistry';
import type { ShortcutConflict } from '~/utils/shortcutRegistry';
import { SHORTCUT_CATALOG } from '~/utils/shortcutCatalog';
import type { ShortcutPreset, StoredShortcutOverride } from '~/utils/shortcutPresets';
import {
	SHORTCUT_PRESETS,
	isRemappableShortcut,
	shortcutOverridesToOverlay,
} from '~/utils/shortcutPresets';
import { applyShortcutPreferences, shortcutBindings } from '~/utils/shortcutScope';

export interface RemapResult {
	ok: boolean;
	/** Populated when `ok` is false: who already answers the requested chord. */
	conflicts: ShortcutConflict[];
}

export function useShortcutPreferences() {
	const settings = usePostboxSettings();

	watch(
		[settings.shortcutPreset, settings.shortcutOverrides],
		([preset, overrides]) => {
			applyShortcutPreferences(preset, overrides);
		},
		{ immediate: true }
	);

	/** The remaps the user has actually stored, keyed by catalog id. */
	const overridesById = computed(
		() => new Map(settings.shortcutOverrides.value.map((row) => [row.id, row.keys]))
	);

	/** What binding `id` would get if the pending change were saved. */
	function candidateOverrides(id: string, keys: string[]): StoredShortcutOverride[] {
		const rest = settings.shortcutOverrides.value.filter((row) => row.id !== id);
		return [...rest, { id, keys }];
	}

	/**
	 * Dry-run a remap: the conflicts it WOULD introduce, ignoring any the user
	 * already lives with (a preset the app shipped broken is not this change's
	 * fault, and blaming it here would make the picker impossible to use).
	 */
	function conflictsFor(id: string, keys: string[]): ShortcutConflict[] {
		const candidate = buildShortcutBindings(SHORTCUT_CATALOG, [
			SHORTCUT_PRESETS[settings.shortcutPreset.value],
			shortcutOverridesToOverlay(candidateOverrides(id, keys)),
		]);
		const known = new Set(shortcutBindings.value.conflicts.map((c) => `${c.scope}\0${c.chord}`));
		return candidate.conflicts.filter((c) => !known.has(`${c.scope}\0${c.chord}`));
	}

	/**
	 * Store a remap. Chords are normalized first, so `Cmd+K` and `mod+k` are the
	 * same binding however the picker spelled it, and an unparseable one is
	 * dropped rather than persisted as a chord nothing can ever match.
	 */
	async function remapShortcut(id: string, keys: string[]): Promise<RemapResult> {
		if (!isRemappableShortcut(id)) return { ok: false, conflicts: [] };
		const normalized: string[] = [];
		for (const key of keys) {
			const chord = normalizeChord(key);
			if (chord && !normalized.includes(chord)) normalized.push(chord);
		}
		const conflicts = conflictsFor(id, normalized);
		if (conflicts.length > 0) return { ok: false, conflicts };
		await settings.setShortcutOverrides(candidateOverrides(id, normalized));
		return { ok: true, conflicts: [] };
	}

	/** Drop one remap, handing the shortcut back to the preset. */
	async function clearShortcutOverride(id: string) {
		await settings.setShortcutOverrides(
			settings.shortcutOverrides.value.filter((row) => row.id !== id)
		);
	}

	/** Drop every remap. The preset itself is untouched. */
	async function clearAllShortcutOverrides() {
		await settings.setShortcutOverrides([]);
	}

	async function setPreset(preset: ShortcutPreset) {
		await settings.setShortcutPreset(preset);
	}

	return {
		preset: settings.shortcutPreset,
		overridesById,
		bindings: shortcutBindings,
		conflicts: computed(() => shortcutBindings.value.conflicts),
		isSaving: settings.isSaving,
		isLoading: settings.isLoading,
		setPreset,
		remapShortcut,
		conflictsFor,
		clearShortcutOverride,
		clearAllShortcutOverrides,
	};
}
