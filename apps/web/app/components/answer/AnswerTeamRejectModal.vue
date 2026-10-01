<script setup lang="ts">
/**
 * "Discard draft" for a Team inbox reply in Answer mode: why the agent's draft
 * is thrown out (optional), then the reject. The state is the reply's own
 * (`useAnswerTeamReply().reject`); `confirm` asks the page to run it, since
 * what follows a reject (finishing a queue item) is the page's call.
 */
import type { Ref } from 'vue';

const props = defineProps<{
	reject: { open: Ref<boolean>; reason: Ref<string>; isRejecting: Ref<boolean> };
}>();
const emit = defineEmits<{ confirm: [] }>();
const { t } = useI18n();

const state = props.reject;
</script>

<template>
	<UiModal
		:open="state.open.value"
		:title="t('dashboard.inbox.detail.rejectDraft')"
		:closable="!state.isRejecting.value"
		:persistent="state.isRejecting.value"
		@update:open="(v: boolean) => !v && (state.open.value = false)"
	>
		<p class="mb-4 text-sm text-text-secondary">
			{{ t('dashboard.inbox.detail.rejectModalBody') }}
		</p>
		<textarea
			v-model="state.reason.value"
			rows="3"
			class="input w-full resize-y"
			:placeholder="t('dashboard.inbox.detail.rejectReasonPlaceholder')"
			:disabled="state.isRejecting.value"
		/>
		<template #footer>
			<UiButton
				variant="secondary"
				:disabled="state.isRejecting.value"
				@click="state.open.value = false"
			>
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton variant="danger" :loading="state.isRejecting.value" @click="emit('confirm')">
				{{ t('dashboard.inbox.detail.rejectDraft') }}
			</UiButton>
		</template>
	</UiModal>
</template>
