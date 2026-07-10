<script setup lang="ts">
// Team-inbox collision safety (confirm half): a teammate replied to this thread
// after this reply was opened. This dialog confirms before sending a duplicate.
// It owns the warning copy; the composer's guard opens it (v-model:open) and
// retries the send on `confirm`. Inert on personal mail — the composer never
// opens it there.
const props = defineProps<{
	open: boolean;
	replyByName: string | null;
}>();

const emit = defineEmits<{
	'update:open': [value: boolean];
	confirm: [];
}>();

const description = computed(() =>
	props.replyByName
		? `${props.replyByName} replied to this thread after you opened it. Send your reply anyway?`
		: 'Someone on your team replied to this thread after you opened it. Send your reply anyway?'
);
</script>

<template>
	<UiConfirmationDialog
		:open="open"
		title="A teammate already replied"
		:description="description"
		confirm-text="Send anyway"
		cancel-text="Keep editing"
		@update:open="emit('update:open', $event)"
		@confirm="emit('confirm')"
	/>
</template>
