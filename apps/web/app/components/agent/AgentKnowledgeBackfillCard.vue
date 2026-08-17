<script setup lang="ts">
import { api } from '@owlat/api';

/**
 * One-shot knowledge backfill status for the Instance → Agent settings page:
 * the job the `ai.agent` flag kicks off the first time it flips on. Renders
 * nothing until a job exists, the same shape as its relation-backfill sibling.
 * Copy stays under the agent settings namespace it was written for.
 */
const { t } = useI18n();
const { showToast } = useToast();

// Knowledge backfill status (live-reactive Convex query — no manual polling)
const { data: backfillJob } = useConvexQuery(api.agent.knowledgeBackfill.getStatus, () => ({}));
const { run: cancelBackfill } = useBackendOperation(api.agent.knowledgeBackfill.cancel, {
	label: () => t('dashboard.admin.instance.agent.cancelBackfillOperation'),
});

const backfillProgressPercent = computed(() => {
	const job = backfillJob.value;
	if (!job || job.totalCount <= 0) return 0;
	const pct = Math.round((job.scannedCount / job.totalCount) * 100);
	return Math.min(100, Math.max(0, pct));
});

const isCancellingBackfill = ref(false);
const handleCancelBackfill = async () => {
	isCancellingBackfill.value = true;
	const result = await cancelBackfill({});
	isCancellingBackfill.value = false;
	if (result === undefined) return;
	showToast(t('dashboard.admin.instance.agent.backfillCancelledToast'));
};

const backfillStatusLabel = computed(() => {
	const job = backfillJob.value;
	if (!job) return '';
	switch (job.status) {
		case 'pending':
			return t('dashboard.admin.instance.agent.backfillStatus.pending');
		case 'running':
			return t('dashboard.admin.instance.agent.backfillStatus.running');
		case 'completed':
			return t('dashboard.admin.instance.agent.backfillStatus.completed');
		case 'cancelled':
			return t('dashboard.admin.instance.agent.backfillStatus.cancelled');
		case 'failed':
			return t('dashboard.admin.instance.agent.backfillStatus.failed');
		default:
			return job.status;
	}
});

const backfillStatusVariant = computed(() => {
	const job = backfillJob.value;
	if (!job) return 'neutral';
	switch (job.status) {
		case 'running':
		case 'pending':
			return 'brand';
		case 'completed':
			return 'success';
		case 'cancelled':
			return 'neutral';
		case 'failed':
			return 'danger';
		default:
			return 'neutral';
	}
});
</script>

<template>
	<!-- Knowledge Backfill Section (only visible when a job exists) -->
	<div v-if="backfillJob" class="card">
		<div class="flex items-start justify-between gap-4 mb-1">
			<div>
				<h2 class="text-lg font-medium text-text-primary mb-1">
					{{ t('dashboard.admin.instance.agent.backfill.title') }}
				</h2>
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.admin.instance.agent.backfill.description') }}
				</p>
			</div>
			<span
				:class="[
					'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap',
					backfillStatusVariant === 'brand' && 'bg-brand-subtle text-brand',
					backfillStatusVariant === 'success' && 'bg-success-subtle text-success',
					backfillStatusVariant === 'danger' && 'bg-error-subtle text-error',
					backfillStatusVariant === 'neutral' && 'bg-bg-surface text-text-secondary',
				]"
			>
				{{ backfillStatusLabel }}
			</span>
		</div>

		<div class="mt-6 space-y-3">
			<!-- Progress bar -->
			<div>
				<div class="flex items-center justify-between text-sm mb-1">
					<span class="text-text-secondary">
						{{
							t('dashboard.admin.instance.agent.backfill.progress', {
								scanned: backfillJob.scannedCount,
								total: backfillJob.totalCount,
							})
						}}
					</span>
					<span class="font-mono text-text-tertiary">{{ backfillProgressPercent }}%</span>
				</div>
				<UiProgressBar
					size="sm"
					:value="backfillProgressPercent"
					:aria-label="t('dashboard.admin.instance.agent.backfill.progressLabel')"
				/>
			</div>

			<!-- Counters -->
			<div class="grid grid-cols-3 gap-3 text-xs">
				<div class="rounded-lg bg-bg-surface px-3 py-2">
					<div class="text-text-tertiary">
						{{ t('dashboard.admin.instance.agent.backfill.extracted') }}
					</div>
					<div class="font-mono text-text-primary text-base">
						{{ backfillJob.extractedCount }}
					</div>
				</div>
				<div class="rounded-lg bg-bg-surface px-3 py-2">
					<div class="text-text-tertiary">
						{{ t('dashboard.admin.instance.agent.backfill.skipped') }}
					</div>
					<div class="font-mono text-text-primary text-base">
						{{ backfillJob.skippedCount }}
					</div>
				</div>
				<div class="rounded-lg bg-bg-surface px-3 py-2">
					<div class="text-text-tertiary">
						{{ t('dashboard.admin.instance.agent.backfill.errors') }}
					</div>
					<div class="font-mono text-text-primary text-base">
						{{ backfillJob.errorCount }}
					</div>
				</div>
			</div>

			<!-- Cancel (only when running/pending) -->
			<div v-if="backfillJob.status === 'running' || backfillJob.status === 'pending'" class="pt-2">
				<UiButton
					variant="secondary"
					type="button"
					class="text-sm gap-2"
					:disabled="isCancellingBackfill"
					@click="handleCancelBackfill"
				>
					<UiSpinner v-if="isCancellingBackfill" size="xs" tone="brand" />
					<Icon v-else name="lucide:x" class="w-3.5 h-3.5" />
					{{ t('dashboard.admin.instance.agent.backfill.cancel') }}
				</UiButton>
			</div>

			<!-- Error message (failed only) -->
			<div
				v-if="backfillJob.status === 'failed' && backfillJob.errorMessage"
				class="text-sm text-error bg-error-subtle/50 rounded-lg px-3 py-2"
			>
				{{ backfillJob.errorMessage }}
			</div>
		</div>
	</div>
</template>
