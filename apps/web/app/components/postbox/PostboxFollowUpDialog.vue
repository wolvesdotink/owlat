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

const { t } = useI18n();

const PRESETS = computed<PresetTimeOption[]>(() => {
	const dow = new Date().getDay();
	return [
		{
			label: t('components.postbox.postboxFollowUpDialog.presets.tomorrow'),
			sub: t('components.postbox.postboxFollowUpDialog.presets.morning'),
			when: () => nextOccurrence(9, 1),
		},
		{
			label: t('components.postbox.postboxFollowUpDialog.presets.inThreeDays'),
			sub: t('components.postbox.postboxFollowUpDialog.presets.morning'),
			when: () => nextOccurrence(9, 3),
		},
		{
			label: t('components.postbox.postboxFollowUpDialog.presets.nextWeek'),
			sub: t('components.postbox.postboxFollowUpDialog.presets.mondayMorning'),
			when: () => nextOccurrence(9, (8 - dow) % 7 || 7),
		},
	];
});
</script>

<template>
	<PostboxPresetTimeDialog
		:open="open"
		:title="t('components.postbox.postboxFollowUpDialog.title')"
		:presets="PRESETS"
		:confirm-label="t('components.postbox.postboxFollowUpDialog.confirmLabel')"
		@update:open="emit('update:open', $event)"
		@confirm="emit('confirm', $event)"
	/>
</template>
