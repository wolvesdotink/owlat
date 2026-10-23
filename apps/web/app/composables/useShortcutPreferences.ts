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
 * The row is read through the soft-auth `mail.settings.get` and written
 * through `preferences.shortcuts.update`, which carries no personal-mail
 * floor: the shortcuts cover every surface, so an instance without mail can
 * remap them too.
 *
 * A remap is REFUSED rather than merged when it would make two shortcuts that
 * can be live together answer the same press: the same chord, or a chord that
 * starts another, in one scope — and a Cmd/Ctrl chord a fixed shortcut of any
 * scope already answers in its own handler, which would swallow it. Those
 * handlers match more loosely than their catalog chords (⌘K with Alt too, ⌘1–9
 * by key position, so ⌘⇧1 as well), so the check asks their own predicates
 * (`utils/fixedShortcutPresses.ts`), not the catalog strings.
 * `buildShortcutBindings` survives a conflict (a broken shortcut must not take
 * the rest of the keyboard down), but there is no reason to persist one: the
 * picker can tell the user which shortcut is in the way before anything is
 * written.
 */

import { api } from '@owlat/api';
import {
	buildShortcutBindings,
	chordFromEvent,
	isModifierChord,
	normalizeChord,
} from '~/utils/shortcutRegistry';
import type { ShortcutConflict } from '~/utils/shortcutRegistry';
import { SHORTCUT_CATALOG } from '~/utils/shortcutCatalog';
import type { ShortcutPressLike } from '~/utils/fixedShortcutPresses';
import { fixedShortcutListenerFor, shortcutPressesForChord } from '~/utils/fixedShortcutPresses';
import type { ShortcutPreset, StoredShortcutOverride } from '~/utils/shortcutPresets';
import {
	SHORTCUT_PRESETS,
	isRemappableShortcut,
	shortcutOverridesToOverlay,
} from '~/utils/shortcutPresets';
import { applyShortcutPreferences, shortcutBindings } from '~/utils/shortcutScope';
import { optimisticUpdateShortcutSettings } from '~/lib/mailOptimistic/settingsUpdater';
import { usePostboxSettings } from '~/composables/postbox/usePostboxSettings';

export interface RemapResult {
	ok: boolean;
	/** Populated when `ok` is false: who already answers the requested chord. */
	conflicts: ShortcutConflict[];
}

const conflictKey = (c: ShortcutConflict) => `${c.scope}\0${c.chord}\0${c.kind ?? ''}`;

/**
 * Fixed Cmd/Ctrl chords that `chords` would collide with: a fixed catalog chord
 * of ANOTHER scope, or any press a fixed shortcut's own listener answers
 * whatever scope is claimed (⌘K, ⌘1–9, ⌘Enter, ⌘⇧F), so a remap onto one would
 * either never fire or fire alongside it. `press` is the keydown the page
 * captured, when there is one: it carries the key position a chord string
 * cannot (Ctrl+& is ⌘1's key on a French keyboard). A chord the id already
 * ships with is exempt: ⌘J is the Assistant everywhere and "Draft with AI" in
 * Answer mode by design.
 */
function fixedChordConflicts(
	id: string,
	chords: readonly string[],
	shipped: readonly string[],
	press?: ShortcutPressLike
): ShortcutConflict[] {
	const def = SHORTCUT_CATALOG.find((entry) => entry.id === id);
	if (!def) return [];
	const found: ShortcutConflict[] = [];
	for (const chord of chords) {
		if (!isModifierChord(chord) || shipped.includes(chord)) continue;
		const presses = shortcutPressesForChord(chord);
		if (press && chordFromEvent(press) === chord) presses.push(press);
		const listener = fixedShortcutListenerFor(presses, id);
		const owner =
			SHORTCUT_CATALOG.find(
				(other) =>
					other.id !== id &&
					other.scope !== def.scope &&
					other.remappable === false &&
					other.keys.some((key) => normalizeChord(key) === chord)
			) ?? SHORTCUT_CATALOG.find((other) => other.id === listener);
		if (owner) found.push({ scope: owner.scope, chord, ids: [owner.id, id] });
	}
	return found;
}

export function useShortcutPreferences() {
	const settings = usePostboxSettings();
	const { t } = useI18n();
	const saveOp = useBackendOperation(api.preferences.shortcuts.update, {
		label: () => t('components.preferences.preferencesShortcuts.saveOperation'),
		optimisticUpdate: optimisticUpdateShortcutSettings,
	});

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
	function conflictsFor(id: string, keys: string[], press?: ShortcutPressLike): ShortcutConflict[] {
		const preset = SHORTCUT_PRESETS[settings.shortcutPreset.value];
		const candidate = buildShortcutBindings(SHORTCUT_CATALOG, [
			preset,
			shortcutOverridesToOverlay(candidateOverrides(id, keys)),
		]);
		const known = new Set(shortcutBindings.value.conflicts.map(conflictKey));
		const shipped = buildShortcutBindings(SHORTCUT_CATALOG, [preset]).byId.get(id) ?? [];
		const found = candidate.conflicts.filter((c) => !known.has(conflictKey(c)));
		for (const conflict of fixedChordConflicts(id, keys, shipped, press)) {
			const key = conflictKey(conflict);
			if (!found.some((c) => conflictKey(c) === key)) found.push(conflict);
		}
		return found;
	}

	/**
	 * Store a remap. Chords are normalized first, so `Cmd+K` and `mod+k` are the
	 * same binding however the picker spelled it, and an unparseable one is
	 * dropped rather than persisted as a chord nothing can ever match. `press`
	 * is the keydown the chord was captured from, if any (see
	 * `fixedChordConflicts`).
	 */
	async function remapShortcut(
		id: string,
		keys: string[],
		press?: ShortcutPressLike
	): Promise<RemapResult> {
		if (!isRemappableShortcut(id)) return { ok: false, conflicts: [] };
		const normalized: string[] = [];
		for (const key of keys) {
			const chord = normalizeChord(key);
			if (chord && !normalized.includes(chord)) normalized.push(chord);
		}
		const conflicts = conflictsFor(id, normalized, press);
		if (conflicts.length > 0) return { ok: false, conflicts };
		await saveOp.run({ shortcutOverrides: candidateOverrides(id, normalized) });
		return { ok: true, conflicts: [] };
	}

	/** Drop one remap, handing the shortcut back to the preset. */
	async function clearShortcutOverride(id: string) {
		await saveOp.run({
			shortcutOverrides: settings.shortcutOverrides.value.filter((row) => row.id !== id),
		});
	}

	/** Drop every remap. The preset itself is untouched. */
	async function clearAllShortcutOverrides() {
		await saveOp.run({ shortcutOverrides: [] });
	}

	async function setPreset(preset: ShortcutPreset) {
		await saveOp.run({ shortcutPreset: preset });
	}

	return {
		preset: settings.shortcutPreset,
		overridesById,
		bindings: shortcutBindings,
		conflicts: computed(() => shortcutBindings.value.conflicts),
		isSaving: saveOp.isLoading,
		setPreset,
		remapShortcut,
		conflictsFor,
		clearShortcutOverride,
		clearAllShortcutOverrides,
	};
}
