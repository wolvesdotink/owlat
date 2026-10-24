<script setup lang="ts">
/**
 * One row of the shortcuts page: what the shortcut does, the keys that fire it
 * now, and either the Change / Reset pair or why it is fixed. The capture
 * itself is the page's business (it owns which row is listening and talks to
 * the preferences); the row only reports the press.
 */
import { formatChord } from '~/utils/shortcutRegistry';
import type { ShortcutSettingsRow } from '~/utils/shortcutSettingsRows';

export interface ShortcutRowRefusal {
	reason: 'modifier' | 'needsModifier' | 'reserved' | 'taken' | 'prefix';
	/** The shortcut in the way, for `taken` and `prefix`. */
	shortcut?: string;
}

const props = defineProps<{
	row: ShortcutSettingsRow;
	isMac: boolean;
	capturing: boolean;
	refusal: ShortcutRowRefusal | null;
	/** The labels of the shortcuts this one clashes with right now. */
	clashNames: readonly string[];
	saving: boolean;
}>();
const emit = defineEmits<{ capture: []; captureKey: [event: KeyboardEvent]; reset: [] }>();

const { t } = useI18n();
const ns = 'components.preferences.preferencesShortcuts';

const label = computed(() => t(props.row.def.labelKey));

/** One `<kbd>` run per chord; a summarized family (⌘1–9) prints its summary. */
const keyRuns = computed(() => {
	const { def, chords, fixed } = props.row;
	const shown = fixed && def.displayKeys ? [def.displayKeys] : chords;
	return shown.map((chord) => formatChord(chord, props.isMac));
});

const refusalText = computed(() => {
	const refusal = props.refusal;
	if (!refusal) return '';
	return t(`${ns}.refused.${refusal.reason}`, { shortcut: refusal.shortcut ?? '' });
});

function onKeydown(event: KeyboardEvent) {
	if (props.capturing) emit('captureKey', event);
}
</script>

<template>
	<li class="px-5 py-2.5" :data-shortcut-id="row.def.id">
		<div class="flex items-center gap-3">
			<div class="min-w-0 flex-1">
				<p class="text-sm text-text-secondary">{{ label }}</p>
				<p v-if="row.fixed && row.def.fixedReason" class="text-xs text-text-tertiary mt-0.5">
					{{ t(`${ns}.fixedReasons.${row.def.fixedReason}`) }}
				</p>
			</div>

			<span v-if="!capturing" class="flex flex-wrap items-center justify-end gap-1 shrink-0">
				<span v-for="(run, runIndex) in keyRuns" :key="runIndex" class="flex items-center gap-0.5">
					<kbd
						v-for="(key, index) in run"
						:key="index"
						class="px-1.5 py-0.5 rounded border border-border-subtle bg-bg-surface text-xs font-mono text-text-primary"
						>{{ key }}</kbd
					>
				</span>
				<span v-if="keyRuns.length === 0" class="text-xs text-text-tertiary">{{
					t(`${ns}.unbound`)
				}}</span>
			</span>

			<UiBadge v-if="row.fixed" variant="neutral" class="shrink-0">{{ t(`${ns}.fixed`) }}</UiBadge>
			<template v-else>
				<UiButton
					variant="secondary"
					size="sm"
					class="shrink-0"
					:disabled="saving"
					:aria-label="t(`${ns}.changeAriaLabel`, { shortcut: label })"
					@click="emit('capture')"
					@keydown="onKeydown"
				>
					{{ capturing ? t(`${ns}.listening`) : t(`${ns}.change`) }}
				</UiButton>
				<UiButton
					v-if="row.overridden"
					variant="ghost"
					size="sm"
					class="shrink-0"
					:disabled="saving"
					:aria-label="t(`${ns}.resetAriaLabel`, { shortcut: label })"
					@click="emit('reset')"
				>
					{{ t(`${ns}.reset`) }}
				</UiButton>
			</template>
		</div>

		<p v-if="refusal" class="text-xs text-error mt-1">{{ refusalText }}</p>
		<p v-if="clashNames.length > 0" class="text-xs text-warning mt-1">
			{{ t(`${ns}.clashesWith`, { shortcuts: clashNames.join(', ') }) }}
		</p>
	</li>
</template>
