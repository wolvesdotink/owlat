<script setup lang="ts">
/**
 * Composer-footer "Remind me if no reply by…" toggle (Boomerang-style).
 * The clock button opens the preset picker when off and clears the stored
 * deadline when on; the deadline (`remindAt` v-model) autosaves onto the draft
 * and arms a thread follow-up watch at send time.
 *
 * This component renders ONLY the toggle: the picker dialog is rendered by the
 * footer and driven through the `pickerOpen` v-model. The toggle lives inside
 * the footer's ⋯ overflow menu, whose panel is `v-if`-ed away on the first
 * click outside it — and a click inside the teleported dialog counts as
 * outside. Owning the dialog here would therefore unmount it mid-interaction.
 */
const remindAt = defineModel<number | null>('remindAt', { required: true });
/** Whether the parent-rendered preset picker is open. */
const pickerOpen = defineModel<boolean>('pickerOpen', { required: true });

defineProps<{
	/** Scheduled sends can't carry a composer reminder — disable the toggle. */
	disabled?: boolean;
}>();

function toggle() {
	if (remindAt.value) {
		remindAt.value = null;
		return;
	}
	pickerOpen.value = true;
}

const title = computed(() =>
	remindAt.value
		? `Reminder if no reply by ${formatDateTime(remindAt.value)} — click to remove`
		: 'Remind me if no reply'
);
</script>

<template>
	<UiButton
		variant="ghost"
		type="button"
		:class="{ 'text-brand': remindAt }"
		:title="title"
		:aria-label="title"
		:aria-pressed="!!remindAt"
		:disabled="disabled"
		@click="toggle"
	>
		<Icon name="lucide:alarm-clock" class="w-4 h-4" />
		<Icon v-if="remindAt" name="lucide:check" class="w-3 h-3 -ml-1" />
	</UiButton>
</template>
