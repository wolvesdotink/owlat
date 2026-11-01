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

async function saveCommitmentStatus() {
	const result = await setCommitmentStatus.run({
		entryId: props.entry._id,
		commitmentStatus: commitmentStatus.value,
	});
	if (result.ok) showToast(t('dashboard.knowledge.detail.commitmentStatusToast'));
}
</script>

<template>
	<div class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
		<h3 class="mb-3 text-sm font-semibold text-text-primary">
			{{ t('dashboard.knowledge.detail.commitmentStatus') }}
		</h3>
		<UiSelect
			v-model="commitmentStatus"
			:aria-label="t('dashboard.knowledge.detail.commitmentStatus')"
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
		/>
		<UiButton
			class="mt-3"
			size="sm"
			:loading="setCommitmentStatus.isLoading.value"
			@click="saveCommitmentStatus"
		>
			{{ t('dashboard.knowledge.detail.saveStatus') }}
		</UiButton>
	</div>
</template>
