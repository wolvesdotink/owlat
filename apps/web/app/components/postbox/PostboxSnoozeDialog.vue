<script setup lang="ts">
import {
	computeSnoozePresets,
	detectSnoozeHint,
	type SnoozePresetKey,
} from '@owlat/shared/snoozePresets';
import type { PresetTimeOption, PresetTimeAction } from './PostboxPresetTimeDialog.vue';

const props = withDefaults(
	defineProps<{
		open: boolean;
		/**
		 * Thread text (subject + snippet) used to infer the suggested wake time.
		 * Deterministic + fail-soft: no match simply shows plain presets.
		 */
		hintText?: string;
	}>(),
	{ hintText: '' },
);

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
	(e: 'confirm', timestamp: number): void;
	/** "Snooze until they reply" — carries the fallback cap timestamp. */
	(e: 'confirm-until-reply', capTimestamp: number): void;
}>();

/** Fallback cap for "until they reply" — resurface after a week if no reply. */
const UNTIL_REPLY_CAP_MS = 7 * 24 * 60 * 60 * 1000;

// Presets are resolved at open time from the shared, timezone-aware helper so
// the dialog and the backend agree on every wake timestamp. The content hint is
// deterministic; an LLM upgrade (if wired) would just supply a different
// `suggested` key here and still degrade to this on any failure.
const PRESETS = computed<PresetTimeOption[]>(() => {
	const now = Date.now();
	const tzOffsetMinutes = -new Date().getTimezoneOffset();
	const suggested: SnoozePresetKey | null = detectSnoozeHint(props.hintText);
	return computeSnoozePresets({ now, tzOffsetMinutes, suggested }).map((p) => ({
		label: p.label,
		sub: p.sub,
		when: () => p.at,
		...(p.suggested ? { suggested: true } : {}),
	}));
});

const ACTIONS: PresetTimeAction[] = [
	{
		id: 'until-reply',
		label: 'Until they reply',
		sub: 'Or in 1 week',
	},
];

function onAction(id: string) {
	if (id === 'until-reply') {
		emit('confirm-until-reply', Date.now() + UNTIL_REPLY_CAP_MS);
	}
}
</script>

<template>
	<PostboxPresetTimeDialog
		:open="open"
		title="Snooze until"
		:presets="PRESETS"
		:actions="ACTIONS"
		confirm-label="Snooze"
		@update:open="emit('update:open', $event)"
		@confirm="emit('confirm', $event)"
		@action="onAction"
	/>
</template>
