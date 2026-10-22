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
 * scope already answers in its own handler, which would swallow it.
 * `buildShortcutBindings` survives a conflict (a broken shortcut must not take
 * the rest of the keyboard down), but there is no reason to persist one: the
 * picker can tell the user which shortcut is in the way before anything is
 * written.
 */

import { api } from '@owlat/api';
import { buildShortcutBindings, isModifierChord, normalizeChord } from '~/utils/shortcutRegistry';
import type { ShortcutConflict } from '~/utils/shortcutRegistry';
import { SHORTCUT_CATALOG } from '~/utils/shortcutCatalog';
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
 * Fixed Cmd/Ctrl chords of OTHER scopes that `chords` would collide with. Those
 * are answered by their own listeners whatever scope is claimed (⌘K, ⌘1–9,
 * ⌘Enter, ⌘⇧F), so a remap onto one would either never fire or steal it. A
 * chord the id already ships with is exempt: ⌘J is the Assistant everywhere
 * and "Draft with AI" in Answer mode by design.
 */
function fixedChordConflicts(
	id: string,
	chords: readonly string[],
	shipped: readonly string[]
): ShortcutConflict[] {
	const def = SHORTCUT_CATALOG.find((entry) => entry.id === id);
	if (!def) return [];
	const found: ShortcutConflict[] = [];
	for (const chord of chords) {
		if (!isModifierChord(chord) || shipped.includes(chord)) continue;
		const owner = SHORTCUT_CATALOG.find(
			(other) =>
				other.id !== id &&
				other.scope !== def.scope &&
				other.remappable === false &&
				other.keys.some((key) => normalizeChord(key) === chord)
		);
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
	function conflictsFor(id: string, keys: string[]): ShortcutConflict[] {
		const preset = SHORTCUT_PRESETS[settings.shortcutPreset.value];
		const candidate = buildShortcutBindings(SHORTCUT_CATALOG, [
			preset,
			shortcutOverridesToOverlay(candidateOverrides(id, keys)),
		]);
		const known = new Set(shortcutBindings.value.conflicts.map(conflictKey));
		const shipped = buildShortcutBindings(SHORTCUT_CATALOG, [preset]).byId.get(id) ?? [];
		return [
			...candidate.conflicts.filter((c) => !known.has(conflictKey(c))),
			...fixedChordConflicts(id, keys, shipped),
		];
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
