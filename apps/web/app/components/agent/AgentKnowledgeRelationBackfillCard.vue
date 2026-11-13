<script setup lang="ts">
import { api } from '@owlat/api';

const { t, te } = useI18n();
const { data: job } = useConvexQuery(api.knowledge.edgeBackfill.getStatus, () => ({}));
const { run: cancel, isLoading: isCancelling } = useBackendOperation(
	api.knowledge.edgeBackfill.cancel,
	{ label: () => t('components.agent.agentKnowledgeRelationBackfillCard.cancelOperation') }
);
const { showToast } = useToast();
// The badge shows the job status verbatim; a status the catalog has not caught
// up with still renders as the backend word rather than a raw key path.
const statusLabel = computed(() => {
	const status = job.value?.status;
	if (!status) return '';
	const key = `components.agent.agentKnowledgeRelationBackfillCard.status.${status}`;
	return te(key) ? t(key) : status;
});
const progressPercent = computed(() => {
	if (!job.value || job.value.totalCount <= 0) return 0;
	return Math.min(
		100,
		Math.max(0, Math.round((job.value.scannedCount / job.value.totalCount) * 100))
	);
});
// Same status -> tone map as the sibling message backfill card: a failed job
// must not look like an idle one.
const statusVariant = computed(() => {
	switch (job.value?.status) {
		case 'running':
		case 'pending':
			return 'default';
		case 'completed':
			return 'success';
		case 'failed':
			return 'error';
		default:
			return 'neutral';
	}
});
async function handleCancel() {
	const result = await cancel({});
	if (result.ok) showToast(t('components.agent.agentKnowledgeRelationBackfillCard.cancelledToast'));
}
</script>

<template>
	<div v-if="job" class="card">
		<div class="flex items-start justify-between gap-4">
			<div>
				<h2 class="text-lg font-medium text-text-primary">
					{{ t('components.agent.agentKnowledgeRelationBackfillCard.title') }}
				</h2>
				<p class="mt-1 text-sm text-text-secondary">
					{{ t('components.agent.agentKnowledgeRelationBackfillCard.description') }}
				</p>
			</div>
			<UiBadge :variant="statusVariant" class="whitespace-nowrap">
				{{ statusLabel }}
			</UiBadge>
		</div>
		<div class="mt-5">
			<div class="mb-1 flex items-center justify-between text-sm">
				<span class="text-text-secondary">
					{{
						t('components.agent.agentKnowledgeRelationBackfillCard.progress', {
							scanned: job.scannedCount,
							total: job.totalCount,
						})
					}}
				</span>
				<span class="font-mono text-text-tertiary">{{ progressPercent }}%</span>
			</div>
			<UiProgressBar
				size="sm"
				:value="progressPercent"
				:aria-label="t('components.agent.agentKnowledgeRelationBackfillCard.progressLabel')"
			/>
			<UiButton
				v-if="job.status === 'running' || job.status === 'pending'"
				class="mt-4"
				variant="secondary"
				size="sm"
				:loading="isCancelling"
				@click="handleCancel"
			>
				{{ t('components.agent.agentKnowledgeRelationBackfillCard.cancel') }}
			</UiButton>
			<p
				v-if="job.status === 'failed' && job.errorMessage"
				class="mt-4 text-sm text-error bg-error-subtle/50 rounded-lg px-3 py-2"
				role="alert"
			>
				{{ job.errorMessage }}
			</p>
		</div>
	</div>
</template>
