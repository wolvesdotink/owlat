<script setup lang="ts">
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
	const now = new Date();
	const items: PresetTimeOption[] = [];

	// Later today @ 18:00 — only if it's still before 18:00
	if (now.getHours() < 18) {
		items.push({
			label: 'Later today',
			sub: '6:00 PM',
			when: () => nextOccurrence(18, 0),
		});
	}
	items.push({
		label: 'Tonight',
		sub: '8:00 PM',
		when: () => nextOccurrence(20, now.getHours() >= 20 ? 1 : 0),
	});
	items.push({
		label: 'Tomorrow',
		sub: '9:00 AM',
		when: () => nextOccurrence(9, 1),
	});
	// This weekend — Saturday 9am
	const dow = now.getDay();
	const daysToSat = dow === 6 ? 7 : 6 - dow;
	if (daysToSat > 0) {
		items.push({
			label: 'This weekend',
			sub: 'Sat 9:00 AM',
			when: () => nextOccurrence(9, daysToSat),
		});
	}
	items.push({
		label: 'Next week',
		sub: 'Mon 9:00 AM',
		when: () => nextOccurrence(9, (8 - dow) % 7 || 7),
	});
	return items;
});
</script>

<template>
	<PostboxPresetTimeDialog
		:open="open"
		title="Snooze until"
		:presets="PRESETS"
		confirm-label="Snooze"
		@update:open="emit('update:open', $event)"
		@confirm="emit('confirm', $event)"
	/>
</template>
