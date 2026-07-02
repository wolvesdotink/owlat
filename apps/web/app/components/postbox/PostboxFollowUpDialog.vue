<script setup lang="ts">
/**
 * "Remind me if no reply by…" preset picker. Thin wrapper over the shared
 * PostboxPresetTimeDialog. Used by the composer footer toggle (stores the
 * deadline on the draft) and by the reader/sent-list to arm a follow-up on an
 * already-sent message.
 */
import type { PresetTimeOption } from './PostboxPresetTimeDialog.vue';

defineProps<{
	open: boolean;
}>();

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
	(e: 'confirm', timestamp: number): void;
}>();

function nextOccurrence(hour: number, dayOffset = 0): number {
	const d = new Date();
	d.setDate(d.getDate() + dayOffset);
	d.setHours(hour, 0, 0, 0);
	return d.getTime();
}

const PRESETS = computed<PresetTimeOption[]>(() => {
	const dow = new Date().getDay();
	return [
		{ label: 'Tomorrow', sub: '9:00 AM', when: () => nextOccurrence(9, 1) },
		{ label: 'In 3 days', sub: '9:00 AM', when: () => nextOccurrence(9, 3) },
		{
			label: 'Next week',
			sub: 'Mon 9:00 AM',
			when: () => nextOccurrence(9, (8 - dow) % 7 || 7),
		},
	];
});
</script>

<template>
	<PostboxPresetTimeDialog
		:open="open"
		title="Remind me if no reply by"
		:presets="PRESETS"
		confirm-label="Remind me"
		@update:open="emit('update:open', $event)"
		@confirm="emit('confirm', $event)"
	/>
</template>
