<script setup lang="ts">
/**
 * "Keyboard shortcuts" (idea 43b): pick the map you already know, then move the
 * few keys you disagree with.
 *
 * The preset is the important half — someone arriving from Gmail wants `b` to
 * snooze, and telling them to rebind nine keys one at a time is not an answer.
 * Per-shortcut remapping is the escape hatch on top, and it is CAPTURED rather
 * than typed: you press the key you want while the row is listening, so the
 * chord stored is exactly the one your keyboard produces (which is the whole
 * reason `U` and `u` are different bindings).
 *
 * A remap that would collide inside a scope is REFUSED with the name of the
 * shortcut in the way, rather than silently shadowing it — the registry
 * survives a conflict, but there is no reason to write one down.
 *
 * Only the mailbox vocabulary is offered. The app-wide `g` chords are few and
 * memorable, and the fixed chords (Esc, ⌘Enter, ⌘1–9) are platform conventions
 * the catalog marks non-remappable.
 */
import { SHORTCUT_CATALOG } from '~/utils/shortcutCatalog';
import { SHORTCUT_PRESET_IDS, type ShortcutPreset } from '~/utils/shortcutPresets';
import { chordFromEvent, formatChord } from '~/utils/shortcutRegistry';

const { t } = useI18n();
const {
	preset,
	overridesById,
	bindings,
	isSaving,
	setPreset,
	remapShortcut,
	clearShortcutOverride,
	clearAllShortcutOverrides,
} = useShortcutPreferences();

const { platform } = useDesktopContext();
const isMac = computed(() => import.meta.client && platform.value === 'mac');

const remappable = SHORTCUT_CATALOG.filter(
	(def) => def.scope === 'postbox' && def.remappable !== false
);

/** The row currently listening for a keypress, if any. */
const capturing = ref<string | null>(null);
/** The shortcut a refused remap collided with (rendered under that row). */
const blockedBy = ref<{ id: string; conflictLabel: string } | null>(null);

function chordsFor(id: string): string[] {
	return [...(bindings.value.byId.get(id) ?? [])];
}

function keysFor(id: string): string[] {
	return chordsFor(id).flatMap((chord) => formatChord(chord, isMac.value));
}

function labelForId(id: string): string {
	const def = SHORTCUT_CATALOG.find((entry) => entry.id === id);
	return def ? t(def.labelKey) : id;
}

function startCapture(id: string) {
	blockedBy.value = null;
	capturing.value = capturing.value === id ? null : id;
}

/** Modifier presses on their own are the user reaching for a chord, not a key. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

async function onCaptureKey(id: string, event: KeyboardEvent) {
	if (MODIFIER_KEYS.has(event.key)) return;
	event.preventDefault();
	event.stopPropagation();
	if (event.key === 'Escape') {
		capturing.value = null;
		return;
	}
	const result = await remapShortcut(id, [chordFromEvent(event)]);
	if (result.ok) {
		capturing.value = null;
		blockedBy.value = null;
		return;
	}
	const taken = result.conflicts[0]?.ids.find((other) => other !== id);
	blockedBy.value = { id, conflictLabel: taken ? labelForId(taken) : '' };
}

const presetOptions = computed(() =>
	SHORTCUT_PRESET_IDS.map((id) => ({
		value: id,
		label: t(`components.postbox.postboxShortcutSettings.presets.${id}`),
	}))
);

const hasOverrides = computed(() => overridesById.value.size > 0);
</script>

<template>
	<section id="shortcuts" class="card !p-0 mb-6 scroll-mt-6">
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 class="font-semibold">{{ t('components.postbox.postboxShortcutSettings.heading') }}</h2>
			<p class="text-xs text-text-tertiary mt-0.5">
				{{ t('components.postbox.postboxShortcutSettings.hint') }}
			</p>
		</header>

		<div class="px-5 py-4 border-b border-border-subtle">
			<UiSelect
				:model-value="preset"
				:label="t('components.postbox.postboxShortcutSettings.presetLabel')"
				:options="presetOptions"
				:disabled="isSaving"
				@update:model-value="setPreset($event as ShortcutPreset)"
			/>
		</div>

		<ul class="divide-y divide-border-subtle">
			<li v-for="def in remappable" :key="def.id" class="px-5 py-2.5">
				<div class="flex items-center gap-3">
					<span class="min-w-0 flex-1 text-sm text-text-secondary">{{ t(def.labelKey) }}</span>

					<span v-if="capturing !== def.id" class="flex items-center gap-1 shrink-0">
						<kbd
							v-for="(key, index) in keysFor(def.id)"
							:key="index"
							class="px-1.5 py-0.5 rounded border border-border-subtle bg-bg-surface text-xs font-mono text-text-primary"
							>{{ key }}</kbd
						>
						<span v-if="keysFor(def.id).length === 0" class="text-xs text-text-tertiary">{{
							t('components.postbox.postboxShortcutSettings.unbound')
						}}</span>
					</span>

					<UiButton
						variant="secondary"
						size="sm"
						class="shrink-0"
						:disabled="isSaving"
						:aria-label="
							t('components.postbox.postboxShortcutSettings.changeAriaLabel', {
								shortcut: t(def.labelKey),
							})
						"
						@click="startCapture(def.id)"
						@keydown="capturing === def.id ? onCaptureKey(def.id, $event) : undefined"
					>
						{{
							capturing === def.id
								? t('components.postbox.postboxShortcutSettings.listening')
								: t('components.postbox.postboxShortcutSettings.change')
						}}
					</UiButton>

					<UiButton
						v-if="overridesById.has(def.id)"
						variant="ghost"
						size="sm"
						class="shrink-0"
						:disabled="isSaving"
						@click="clearShortcutOverride(def.id)"
					>
						{{ t('components.postbox.postboxShortcutSettings.reset') }}
					</UiButton>
				</div>

				<p v-if="blockedBy?.id === def.id" class="text-xs text-error mt-1">
					{{
						t('components.postbox.postboxShortcutSettings.taken', {
							shortcut: blockedBy.conflictLabel,
						})
					}}
				</p>
			</li>
		</ul>

		<footer v-if="hasOverrides" class="px-5 py-3 border-t border-border-subtle">
			<UiButton
				variant="secondary"
				size="sm"
				:disabled="isSaving"
				@click="clearAllShortcutOverrides"
			>
				{{ t('components.postbox.postboxShortcutSettings.resetAll') }}
			</UiButton>
		</footer>
	</section>
</template>
