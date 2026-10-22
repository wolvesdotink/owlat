<script setup lang="ts">
/**
 * "Remind me if no reply by…" preset picker. Thin wrapper over the shared
 * PostboxPresetTimeDialog. Used by the composer footer toggle (stores the
 * deadline on the draft) and by the reader/sent-list to arm a follow-up on an
 * already-sent message.
 */
import type { PresetTimeOption } from './PostboxPresetTimeDialog.vue';
import { followUpPresets } from '~/utils/postboxFollowUpPresets';

defineProps<{
	open: boolean;
}>();

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
	(e: 'confirm', timestamp: number): void;
}>();

const { t } = useI18n();

// The moment is resolved on the click, from the click's "now", so a dialog left
// mounted overnight still arms "tomorrow" for the day after the click.
const PRESETS = computed<PresetTimeOption[]>(() =>
	followUpPresets(new Date()).map((preset) => ({
		label: t(preset.labelKey),
		sub: t(preset.subKey),
		when: () => followUpPresets(new Date()).find((p) => p.id === preset.id)?.at ?? preset.at,
	}))
);
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
