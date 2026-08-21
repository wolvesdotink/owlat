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

const { t } = useI18n();

const description = computed(() =>
	props.replyByName
		? t('components.postbox.postboxStaleReplyDialog.descriptionNamed', {
				name: props.replyByName,
			})
		: t('components.postbox.postboxStaleReplyDialog.description')
);
</script>

<template>
	<UiConfirmationDialog
		:open="open"
		:title="t('components.postbox.postboxStaleReplyDialog.title')"
		:description="description"
		:confirm-text="t('components.postbox.postboxStaleReplyDialog.confirm')"
		:cancel-text="t('components.postbox.postboxStaleReplyDialog.cancel')"
		@update:open="emit('update:open', $event)"
		@confirm="emit('confirm')"
	/>
</template>
