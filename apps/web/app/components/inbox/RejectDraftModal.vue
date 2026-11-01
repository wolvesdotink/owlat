<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

/**
 * The Team Inbox thread page's "Reject draft" confirm, with an optional reason.
 * The reject itself is the page's (it goes through the thread's own operation,
 * which toasts any failure); this owns the reason and the busy state.
 */
const props = defineProps<{
	open: boolean;
	messageId: Id<'inboundMessages'> | null;
	reject: (messageId: Id<'inboundMessages'>, reason?: string) => Promise<{ ok: boolean }>;
}>();

const emit = defineEmits<{ 'update:open': [open: boolean] }>();

const { t } = useI18n();
const { showToast } = useToast();

const isRejecting = ref(false);
const rejectReason = ref('');

// Each opening starts from an empty reason.
watch(
	() => props.open,
	(open) => {
		if (open) rejectReason.value = '';
	}
);

const onReject = async () => {
	if (!props.messageId) return;
	isRejecting.value = true;
	try {
		const result = await props.reject(props.messageId, rejectReason.value || undefined);
		if (result.ok) {
			emit('update:open', false);
			showToast(t('dashboard.inbox.detail.draftRejectedToast'));
		}
	} finally {
		isRejecting.value = false;
	}
};
</script>

<template>
	<UiModal
		:open="open"
		:title="t('dashboard.inbox.detail.rejectDraft')"
		:closable="!isRejecting"
		:persistent="isRejecting"
		@update:open="(v: boolean) => !v && emit('update:open', false)"
	>
		<p class="text-sm text-text-secondary mb-4">
			{{ t('dashboard.inbox.detail.rejectModalBody') }}
		</p>
		<textarea
			v-model="rejectReason"
			rows="3"
			class="input w-full resize-y"
			:placeholder="t('dashboard.inbox.detail.rejectReasonPlaceholder')"
			:disabled="isRejecting"
		/>

		<template #footer>
			<UiButton variant="secondary" :disabled="isRejecting" @click="emit('update:open', false)">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton variant="danger" :loading="isRejecting" @click="onReject">
				{{
					isRejecting
						? t('dashboard.inbox.detail.rejecting')
						: t('dashboard.inbox.detail.rejectDraft')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
