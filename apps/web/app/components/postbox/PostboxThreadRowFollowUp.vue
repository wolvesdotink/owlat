<script setup lang="ts">
/**
 * Thread-row follow-up watch chip (mail/followUps.ts). Renders "No reply yet"
 * once the deadline passed, otherwise a compact armed-reminder pill. Clicking
 * either emits `cancel` (the parent cancels the armed watch / dismisses the due
 * indicator, ownership-checked server-side).
 */
const { t, locale } = useI18n();

defineProps<{
	followUp: { remindAt: number; dueAt?: number; watched: boolean };
}>();

const emit = defineEmits<{
	(e: 'cancel', event: MouseEvent): void;
}>();

/** The armed reminder's absolute time, formatted against the active locale. */
function reminderTitle(remindAt: number): string {
	return t('components.postbox.postboxThreadRowFollowUp.reminderTitle', {
		when: new Date(remindAt).toLocaleString(locale.value),
	});
}
</script>

<template>
	<button
		v-if="followUp.watched && followUp.dueAt"
		type="button"
		class="inline-flex items-center gap-1 px-1.5 py-px rounded-full bg-warning/10 text-warning text-[10px] font-medium hover:bg-warning/20 flex-shrink-0"
		:title="t('components.postbox.postboxThreadRowFollowUp.dueTitle')"
		:aria-label="t('components.postbox.postboxThreadRowFollowUp.dueLabel')"
		@click="emit('cancel', $event)"
	>
		<Icon name="lucide:alarm-clock" class="w-3 h-3" />
		{{ t('components.postbox.postboxThreadRowFollowUp.noReplyYet') }}
	</button>
	<button
		v-else-if="followUp.watched"
		type="button"
		class="inline-flex items-center gap-1 px-1.5 py-px rounded-full bg-brand/10 text-brand text-[10px] font-medium hover:bg-brand/20 flex-shrink-0"
		:title="reminderTitle(followUp.remindAt)"
		:aria-label="t('components.postbox.postboxThreadRowFollowUp.cancelLabel')"
		@click="emit('cancel', $event)"
	>
		<Icon name="lucide:alarm-clock" class="w-3 h-3" />
	</button>
</template>
