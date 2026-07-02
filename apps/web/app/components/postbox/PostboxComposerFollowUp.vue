<script setup lang="ts">
/**
 * Composer-footer "Remind me if no reply by…" toggle (Boomerang-style).
 * The clock button opens the preset picker when off and clears the stored
 * deadline when on; the deadline (`remindAt` v-model) autosaves onto the draft
 * and arms a thread follow-up watch at send time.
 */
const remindAt = defineModel<number | null>('remindAt', { required: true });

defineProps<{
	/** Scheduled sends can't carry a composer reminder — disable the toggle. */
	disabled?: boolean;
}>();

const open = ref(false);

function toggle() {
	if (remindAt.value) {
		remindAt.value = null;
		return;
	}
	open.value = true;
}

const title = computed(() =>
	remindAt.value
		? `Reminder if no reply by ${formatDateTime(remindAt.value)} — click to remove`
		: 'Remind me if no reply'
);
</script>

<template>
	<button
		type="button"
		class="btn btn-ghost"
		:class="{ 'text-brand': remindAt }"
		:title="title"
		:aria-label="title"
		:aria-pressed="!!remindAt"
		:disabled="disabled"
		@click="toggle"
	>
		<Icon name="lucide:alarm-clock" class="w-4 h-4" />
		<Icon v-if="remindAt" name="lucide:check" class="w-3 h-3 -ml-1" />
	</button>
	<PostboxFollowUpDialog
		:open="open"
		@update:open="open = $event"
		@confirm="(ts) => (remindAt = ts)"
	/>
</template>
