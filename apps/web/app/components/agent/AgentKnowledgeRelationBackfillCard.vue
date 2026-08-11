<script setup lang="ts">
import { api } from '@owlat/api';

const { data: job } = useConvexQuery(api.knowledge.edgeBackfill.getStatus, () => ({}));
const { run: cancel, isLoading: isCancelling } = useBackendOperation(
	api.knowledge.edgeBackfill.cancel,
	{ label: 'Cancel relation backfill' }
);
const { showToast } = useToast();
const progressPercent = computed(() => {
	if (!job.value || job.value.totalCount <= 0) return 0;
	return Math.min(
		100,
		Math.max(0, Math.round((job.value.scannedCount / job.value.totalCount) * 100))
	);
});
async function handleCancel() {
	const result = await cancel({});
	if (result) showToast('Relation backfill cancelled');
}
</script>

<template>
	<div v-if="job" class="card">
		<div class="flex items-start justify-between gap-4">
			<div>
				<h2 class="text-lg font-medium text-text-primary">Knowledge relation backfill</h2>
				<p class="mt-1 text-sm text-text-secondary">
					One-time linking of existing knowledge entries for graph-assisted retrieval.
				</p>
			</div>
			<UiBadge :variant="job.status === 'completed' ? 'success' : 'neutral'">
				{{ job.status }}
			</UiBadge>
		</div>
		<div class="mt-5">
			<div class="mb-1 flex items-center justify-between text-sm">
				<span class="text-text-secondary">
					{{ job.scannedCount }} / {{ job.totalCount }} entries
				</span>
				<span class="font-mono text-text-tertiary">{{ progressPercent }}%</span>
			</div>
			<UiProgressBar
				size="sm"
				:value="progressPercent"
				aria-label="Knowledge relation backfill progress"
			/>
			<UiButton
				v-if="job.status === 'running' || job.status === 'pending'"
				class="mt-4"
				variant="secondary"
				size="sm"
				:loading="isCancelling"
				@click="handleCancel"
			>
				Cancel relation backfill
			</UiButton>
		</div>
	</div>
</template>
