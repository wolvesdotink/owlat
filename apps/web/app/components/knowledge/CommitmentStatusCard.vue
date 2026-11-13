<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

type CommitmentStatus = 'open' | 'fulfilled' | 'cancelled';

/** The knowledge entry detail page's commitment status picker, for decisions and action items. */
const props = defineProps<{
	entry: { _id: Id<'knowledgeEntries'>; commitmentStatus?: CommitmentStatus };
}>();

const { t } = useI18n();
const { showToast } = useToast();

const commitmentStatus = ref<CommitmentStatus>('open');
const setCommitmentStatus = useBackendOperation(api.knowledge.graph.setCommitmentStatus, {
	label: () => t('dashboard.knowledge.detail.commitmentStatusOperation'),
});

// Every fresh read of the entry resets the picker to the stored status.
watch(
	() => props.entry,
	(value) => {
		commitmentStatus.value = value?.commitmentStatus ?? 'open';
	},
	{ immediate: true }
);

// A single choice saves the moment it changes, like the other pickers in the
// app; a failed save puts the picker back on the stored status.
async function saveCommitmentStatus(next: CommitmentStatus) {
	const stored = props.entry.commitmentStatus ?? 'open';
	commitmentStatus.value = next;
	if (next === stored) return;
	const result = await setCommitmentStatus.run({
		entryId: props.entry._id,
		commitmentStatus: next,
	});
	if (result.ok) showToast(t('dashboard.knowledge.detail.commitmentStatusToast'));
	else commitmentStatus.value = stored;
}
</script>

<template>
	<div class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
		<h3 class="mb-3 text-sm font-semibold text-text-primary">
			{{ t('dashboard.knowledge.detail.commitmentStatus') }}
		</h3>
		<UiSelect
			:model-value="commitmentStatus"
			:aria-label="t('dashboard.knowledge.detail.commitmentStatus')"
			:disabled="setCommitmentStatus.isLoading.value"
			:options="[
				{ value: 'open', label: t('dashboard.knowledge.detail.commitmentStatuses.open') },
				{
					value: 'fulfilled',
					label: t('dashboard.knowledge.detail.commitmentStatuses.fulfilled'),
				},
				{
					value: 'cancelled',
					label: t('dashboard.knowledge.detail.commitmentStatuses.cancelled'),
				},
			]"
			@update:model-value="(value) => value && saveCommitmentStatus(value as CommitmentStatus)"
		/>
	</div>
</template>
