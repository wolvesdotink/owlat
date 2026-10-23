<script setup lang="ts">
/**
 * Every keyboard shortcut the app answers, on one page: pick the map you
 * already know, find a key by name or by chord, and move the ones you
 * disagree with.
 *
 * The preset is the important half — someone arriving from Gmail wants `b` to
 * snooze, and telling them to rebind nine keys one at a time is not an answer.
 * Per-shortcut remapping is the escape hatch on top, and it is CAPTURED rather
 * than typed: you press the key you want while the row is listening, so the
 * chord stored is exactly the one your keyboard produces.
 *
 * Every scope is listed, grouped by where the keys work. Fixed rows say why
 * they are fixed. A remap that would collide is REFUSED with the name of the
 * shortcut in the way (`useShortcutPreferences`), and a clash the person
 * already lives with (a remap that a later preset switch collided with) is
 * flagged on both rows, with Reset one click away.
 */
import { SHORTCUT_CATALOG } from '~/utils/shortcutCatalog';
import { SHORTCUT_PRESET_IDS, type ShortcutPreset } from '~/utils/shortcutPresets';
import type { ShortcutDefinition } from '~/utils/shortcutRegistry';
import { captureShortcutKey } from '~/utils/shortcutCapture';
import { formatChordLabel } from '~/utils/shortcutLabels';
import { shortcutSettingsSections } from '~/utils/shortcutSettingsRows';
import { useShortcutIsMac } from '~/composables/useShortcutLabels';
import { useShortcutPreferences } from '~/composables/useShortcutPreferences';
import PreferencesShortcutRow, { type ShortcutRowRefusal } from './PreferencesShortcutRow.vue';

const { t } = useI18n();
const {
	preset,
	overridesById,
	bindings,
	conflicts,
	isSaving,
	setPreset,
	remapShortcut,
	clearShortcutOverride,
	clearAllShortcutOverrides,
} = useShortcutPreferences();
const { isEnabled } = useFeatureFlag();
const { isDesktop } = useDesktopContext();
const isMac = useShortcutIsMac();

const ns = 'components.preferences.preferencesShortcuts';

const query = ref('');

/** The row currently listening for a keypress, if any. */
const capturing = ref<string | null>(null);
/** Why a capture was refused, rendered under that row. */
const refused = ref<{ id: string; refusal: ShortcutRowRefusal } | null>(null);

const byId = new Map(SHORTCUT_CATALOG.map((def) => [def.id, def]));
function labelForId(id: string): string {
	const def = byId.get(id);
	return def ? t(def.labelKey) : id;
}
const scopeTitle = (scope: string) => t(`${ns}.scopes.${scope}`);

const sections = computed(() =>
	shortcutSettingsSections(SHORTCUT_CATALOG, bindings.value, {
		env: { isFeatureEnabled: isEnabled, isDesktop: isDesktop.value },
		overridden: new Set(overridesById.value.keys()),
		query: query.value,
		describe: (def, chords) => [
			t(def.labelKey),
			scopeTitle(def.scope),
			...chords.map((chord) => formatChordLabel(chord, isMac.value)),
			...chords,
		],
	})
);

/** The clashes the person lives with right now, named for the banner. */
const clashes = computed(() =>
	conflicts.value.map((conflict) => ({
		key: `${conflict.scope}:${conflict.chord}:${conflict.kind ?? ''}`,
		chord: formatChordLabel(conflict.chord, isMac.value),
		names: conflict.ids.map(labelForId).join(', '),
	}))
);

function startCapture(id: string) {
	refused.value = null;
	capturing.value = capturing.value === id ? null : id;
}

async function onCaptureKey(def: ShortcutDefinition, event: KeyboardEvent) {
	// `captureShortcutKey` owns the rules (bare modifier, Escape and Tab, the
	// chord shape this command can take, the keys the browser keeps).
	const capture = captureShortcutKey(event, def);
	if (capture.kind === 'ignore') return;
	if (capture.kind === 'cancel') {
		capturing.value = null;
		// Tab still moves focus on; Escape ends here.
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
		}
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	if (capture.kind === 'refuse') {
		refused.value = { id: def.id, refusal: { reason: capture.reason } };
		return;
	}
	const result = await remapShortcut(def.id, [capture.chord], event);
	if (result.ok) {
		capturing.value = null;
		refused.value = null;
		return;
	}
	const conflict = result.conflicts[0];
	const taken = conflict?.ids.find((other) => other !== def.id);
	refused.value = {
		id: def.id,
		refusal: {
			reason: conflict?.kind === 'prefix' ? 'prefix' : 'taken',
			shortcut: taken ? labelForId(taken) : '',
		},
	};
}

const presetOptions = computed(() =>
	SHORTCUT_PRESET_IDS.map((id) => ({
		value: id,
		label: t(`${ns}.presets.${id}`),
	}))
);

const hasOverrides = computed(() => overridesById.value.size > 0);
</script>

<template>
	<section id="shortcuts" class="card !p-0 mb-6 scroll-mt-6">
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 class="font-semibold">{{ t(`${ns}.heading`) }}</h2>
			<p class="text-xs text-text-tertiary mt-0.5">{{ t(`${ns}.hint`) }}</p>
		</header>

		<div class="grid gap-4 px-5 py-4 border-b border-border-subtle sm:grid-cols-2">
			<UiSelect
				:model-value="preset"
				:label="t(`${ns}.presetLabel`)"
				:options="presetOptions"
				:disabled="isSaving"
				@update:model-value="setPreset($event as ShortcutPreset)"
			/>
			<UiInput
				v-model="query"
				:label="t(`${ns}.filterLabel`)"
				:placeholder="t(`${ns}.filterPlaceholder`)"
				autocomplete="off"
				data-testid="shortcut-filter"
			>
				<template #iconLeft>
					<Icon name="lucide:search" class="size-4" />
				</template>
			</UiInput>
		</div>

		<div
			v-if="clashes.length > 0"
			role="status"
			class="mx-5 mt-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
			data-testid="shortcut-clashes"
		>
			<p class="font-medium text-text-primary">{{ t(`${ns}.clashesHeading`) }}</p>
			<p class="mt-0.5 text-xs text-text-secondary">{{ t(`${ns}.clashesHint`) }}</p>
			<ul class="mt-2 space-y-1 text-xs text-text-secondary">
				<li v-for="clash in clashes" :key="clash.key">
					{{ t(`${ns}.clashLine`, { keys: clash.chord, shortcuts: clash.names }) }}
				</li>
			</ul>
		</div>

		<section
			v-for="section in sections"
			:key="section.scope"
			:aria-labelledby="`shortcut-scope-${section.scope}`"
			:data-scope="section.scope"
		>
			<h3
				:id="`shortcut-scope-${section.scope}`"
				class="px-5 pt-5 pb-2 text-xs font-medium uppercase tracking-wider text-text-tertiary"
			>
				{{ scopeTitle(section.scope) }}
			</h3>
			<ul class="divide-y divide-border-subtle border-y border-border-subtle">
				<PreferencesShortcutRow
					v-for="row in section.rows"
					:key="row.def.id"
					:row="row"
					:is-mac="isMac"
					:capturing="capturing === row.def.id"
					:refusal="refused?.id === row.def.id ? refused.refusal : null"
					:clash-names="row.clashesWith.map(labelForId)"
					:saving="isSaving"
					@capture="startCapture(row.def.id)"
					@capture-key="onCaptureKey(row.def, $event)"
					@reset="clearShortcutOverride(row.def.id)"
				/>
			</ul>
		</section>

		<p v-if="sections.length === 0" class="px-5 py-6 text-sm text-text-tertiary">
			{{ t(`${ns}.noMatch`, { query }) }}
		</p>

		<footer v-if="hasOverrides" class="px-5 py-3 border-t border-border-subtle">
			<UiButton
				variant="secondary"
				size="sm"
				:disabled="isSaving"
				@click="clearAllShortcutOverrides"
			>
				{{ t(`${ns}.resetAll`) }}
			</UiButton>
		</footer>
	</section>
</template>
