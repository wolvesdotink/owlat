<script setup lang="ts">
/**
 * "Ask for a read receipt" in the composer's ⋯ menu. Off unless the sender
 * turns it on for this draft; the saved row is the state, so a reopened or
 * scheduled draft shows what it will send.
 *
 * Written straight to the row (like the From identity), not through autosave:
 * the first toggle creates the row when the draft has none yet.
 */
import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { CheckIcon } from '@coolicons/vue';

const props = defineProps<{
	compose: {
		draftId: Ref<Id<'mailDrafts'> | null>;
		ensureDraft: () => Promise<Id<'mailDrafts'> | null>;
		isScheduled: Readonly<Ref<boolean>>;
	};
}>();

const { t } = useI18n();
const { showOperationError } = useOperationErrorToast();

const draftQuery = useConvexQuery(api.mail.drafts.get, () => {
	const draftId = props.compose.draftId.value;
	return draftId ? { draftId } : 'skip';
});
const saved = computed(() => draftQuery.data.value?.isReadReceiptRequested === true);
// What the last toggle asked for, until the row says so.
const pending = ref<boolean | null>(null);
watch(saved, () => (pending.value = null));
const isRequested = computed(() => pending.value ?? saved.value);

const setRequested = useBackendOperation(api.mail.readReceipts.setRequested, {
	label: () => t('components.postbox.postboxComposerFooter.readReceiptOperation'),
});

async function toggle() {
	const next = !isRequested.value;
	try {
		const draftId = await props.compose.ensureDraft();
		if (!draftId) return;
		pending.value = next;
		const result = await setRequested.run({ draftId, isRequested: next });
		if (!result.ok) pending.value = null;
	} catch (err) {
		// The mutation toasts its own refusals; this is the row that could not be created.
		pending.value = null;
		showOperationError(err);
	}
}
</script>

<template>
	<button
		type="button"
		role="menuitemcheckbox"
		:aria-checked="isRequested"
		:disabled="compose.isScheduled.value"
		class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left whitespace-nowrap hover:bg-bg-surface disabled:opacity-50"
		data-testid="composer-read-receipt"
		@click="toggle"
	>
		<CheckIcon class="w-4 h-4 text-brand" :class="{ invisible: !isRequested }" aria-hidden="true" />
		{{ t('components.postbox.postboxComposerFooter.readReceipt') }}
	</button>
</template>
