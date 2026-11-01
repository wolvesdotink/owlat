<script setup lang="ts">
/**
 * "Embedding search" on the AI provider page, below the
 * embeddings card: which embedding space vector search uses, how much of the
 * knowledge base and file library it reaches, and the work that brings the
 * rest back.
 *
 *  - A vector from before provenance, or from another model, is out of vector
 *    search (keyword search still finds the item) until it is re-embedded into
 *    the active space, or, for vectors from before provenance, an admin
 *    attests which embedder wrote them.
 *  - Re-embedding with a local embedder is free and also runs on its own; with
 *    a hosted one it is paid work an admin starts, through spend admission.
 *  - A staged rebuild (another local model, or another model of the stored
 *    hosted provider) fills the second column beside the active one, and its
 *    activation is one switch with a rollback.
 *
 * The section owns its read and its controls (`useEmbeddingSpaces`); the
 * attestation and the rebuild are their own components.
 */
import { computed } from 'vue';
import { useEmbeddingSpaces } from '~/composables/useEmbeddingSpaces';
import {
	coverageRows,
	embeddingSearchState,
	isAttestationOffered,
	jobStateKey,
	lastFinishedJob,
	openJob,
	configuredKey,
	jobPayment,
	pausedJobKey,
	reembedBlocker,
	reembedCandidates,
	reembedPayment,
	resumeBlocker,
	type EmbeddingJob,
} from '~/utils/embeddingSpaces';
import { useEmbeddingConfirm } from '~/composables/useEmbeddingConfirm';
import { formatDateTime, formatNumber } from '~/utils/formatters';
import { embeddingProviderMeta } from '~/utils/aiProviders';
import { CircleCheckIcon, TriangleWarningIcon } from '@coolicons/vue';

const { t } = useI18n();
const K = 'dashboard.admin.instance.aiProvider.embeddingSpace';

const spaces = useEmbeddingSpaces();
const status = computed(() => spaces.status.value ?? null);

const searchState = computed(() => (status.value ? embeddingSearchState(status.value) : 'none'));
const rows = computed(() => coverageRows(status.value?.coverage ?? null));
const candidates = computed(() => reembedCandidates(status.value?.coverage ?? null));
const reembedJob = computed(() => (status.value ? openJob(status.value.jobs, 'reembed') : null));
const lastReembed = computed(() =>
	status.value ? lastFinishedJob(status.value.jobs, 'reembed') : null
);
const blocker = computed(() => (status.value ? reembedBlocker(status.value) : null));
const isLocal = computed(() => status.value?.configured?.isLocal === true);

const resumeBlock = computed(() =>
	status.value && reembedJob.value ? resumeBlocker(status.value, reembedJob.value) : null
);

// Paid work (the server's locality of the configured endpoint, a job's own
// `isPaid`) is confirmed before it starts; free work starts at once.
const confirmation = useEmbeddingConfirm();
function startReembed() {
	if (!status.value) return;
	// What this confirmation names, captured now: the configured target (also
	// a pending switch's) and the searchable space it goes into, none while a
	// switch is pending. The server refuses if either has moved.
	const expected = {
		...(status.value.configured?.isActive && status.value.active
			? { spaceId: status.value.active._id }
			: {}),
		...(status.value.configured?.targetKey ? { targetKey: status.value.configured.targetKey } : {}),
	};
	void confirmation.ask(reembedPayment(status.value) === 'paid', {
		title: t(`${K}.reembed.confirmTitle`),
		body: t(
			candidates.value.isExact ? `${K}.reembed.confirmBodyExact` : `${K}.reembed.confirmBody`,
			{
				count: formatNumber(candidates.value.count),
				provider: providerLabel(status.value.configured?.provider),
			}
		),
		confirmText: t(`${K}.reembed.confirm`),
		targetKey: configuredKey(status.value) ?? '',
		currentKey: () => configuredKey(status.value),
		blocker: () => (status.value ? reembedBlocker(status.value) : null),
		run: () => spaces.startReembed(expected),
	});
}
function resume(job: EmbeddingJob) {
	void confirmation.ask(jobPayment(job) === 'paid', {
		title: t(`${K}.job.resumeTitle`),
		body: t(`${K}.job.resumeBody`),
		confirmText: t(`${K}.job.resume`),
		targetKey: pausedJobKey(status.value, job._id) ?? '',
		currentKey: () => pausedJobKey(status.value, job._id),
		blocker: () => (status.value ? resumeBlocker(status.value, job) : null),
		run: () => spaces.resume(job),
	});
}

const COUNT_COLUMNS = ['active', 'unknown', 'inactive', 'unembedded'] as const;

/** A provider kind as its settings label ("OpenAI (hosted)"). */
const providerLabel = (kind: string | undefined) => {
	const meta = kind ? embeddingProviderMeta(kind) : undefined;
	return meta ? t(meta.label) : (kind ?? '');
};
</script>

<template>
	<UiCard data-testid="ai-embedding-space">
		<h2 class="text-lg font-medium text-text-primary mb-1">{{ t(`${K}.title`) }}</h2>
		<p class="text-sm text-text-secondary mb-4">{{ t(`${K}.description`) }}</p>

		<UiQueryBoundary
			:loading="spaces.isLoading.value && !status"
			:error="spaces.error.value"
			@retry="spaces.refetch"
		>
			<template #loading>
				<div class="space-y-3" role="status" aria-busy="true" :aria-label="t(`${K}.loading`)">
					<UiSkeleton v-for="row in 3" :key="row" class="h-10 rounded-lg" />
				</div>
			</template>

			<div v-if="status" class="space-y-6">
				<p
					v-if="spaces.isTargetChanged.value"
					class="rounded-lg bg-warning-subtle/50 p-3 text-sm text-text-primary"
					role="alert"
					data-testid="ai-embedding-target-changed"
				>
					{{ t(`${K}.targetChanged`) }}
				</p>
				<div
					class="flex items-start gap-3 rounded-lg border border-border-subtle p-4 text-sm"
					:class="searchState === 'searchable' ? 'bg-success-subtle/50' : 'bg-warning-subtle/50'"
					role="status"
					data-testid="ai-embedding-search-state"
					:data-state="searchState"
				>
					<component
						:is="searchState === 'searchable' ? CircleCheckIcon : TriangleWarningIcon"
						class="w-5 h-5 shrink-0 mt-0.5"
						:class="searchState === 'searchable' ? 'text-success' : 'text-warning'"
					/>
					<div>
						<p class="text-text-primary font-medium">
							{{
								t(`${K}.state.${searchState}.title`, {
									model: status.configured?.model ?? '',
								})
							}}
						</p>
						<p class="text-text-secondary mt-0.5">{{ t(`${K}.state.${searchState}.body`) }}</p>
						<p
							v-if="searchState === 'searchable' && status.active"
							class="mt-1 text-xs text-text-tertiary"
						>
							{{
								t(`${K}.state.space`, {
									provider: providerLabel(status.active.provider),
									dimensions: status.active.dimensions,
								})
							}}
						</p>
					</div>
				</div>

				<section data-testid="ai-embedding-coverage">
					<div class="flex items-center justify-between gap-3">
						<h3 class="text-sm font-medium text-text-primary">{{ t(`${K}.coverage.title`) }}</h3>
						<UiButton
							type="button"
							variant="ghost"
							size="sm"
							:disabled="spaces.isBusy.value"
							@click="spaces.refresh"
						>
							{{ t(`${K}.coverage.refresh`) }}
						</UiButton>
					</div>
					<p v-if="!status.coverage" class="mt-1 text-xs text-text-tertiary">
						{{ t(`${K}.coverage.none`) }}
					</p>
					<template v-else>
						<p class="mt-1 text-xs text-text-tertiary">
							{{
								status.coverage.isCurrent
									? t(`${K}.coverage.measuredAt`, {
											date: formatDateTime(status.coverage.measuredAt),
										})
									: t(`${K}.coverage.stale`)
							}}
						</p>
						<div class="mt-3 overflow-x-auto">
							<table class="w-full text-sm">
								<thead>
									<tr class="text-left text-xs text-text-tertiary">
										<th class="py-1 pr-4 font-normal">
											<span class="sr-only">{{ t(`${K}.coverage.table`) }}</span>
										</th>
										<th
											v-for="column in COUNT_COLUMNS"
											:key="column"
											scope="col"
											class="py-1 pr-4 font-normal"
										>
											{{ t(`${K}.coverage.columns.${column}`) }}
										</th>
									</tr>
								</thead>
								<tbody>
									<tr
										v-for="row in rows"
										:key="row.table"
										class="border-t border-border-subtle"
										:data-testid="`ai-embedding-coverage-${row.table}`"
									>
										<th scope="row" class="py-2 pr-4 text-left font-medium text-text-primary">
											{{ t(`${K}.coverage.tables.${row.table}`) }}
										</th>
										<td
											v-for="column in COUNT_COLUMNS"
											:key="column"
											class="py-2 pr-4 tabular-nums text-text-secondary"
										>
											{{ formatNumber(row.counts[column]) }}
										</td>
									</tr>
								</tbody>
							</table>
						</div>
						<p class="mt-2 text-xs text-text-tertiary">{{ t(`${K}.coverage.legend`) }}</p>
					</template>
				</section>

				<section data-testid="ai-embedding-reembed">
					<h3 class="text-sm font-medium text-text-primary">{{ t(`${K}.reembed.title`) }}</h3>
					<p class="mt-1 text-xs text-text-tertiary">
						{{ t(isLocal ? `${K}.reembed.local` : `${K}.reembed.hosted`) }}
					</p>

					<div
						v-if="reembedJob"
						class="mt-3 rounded-lg border border-border-subtle p-3 text-sm"
						data-testid="ai-embedding-reembed-job"
						:data-status="reembedJob.status"
					>
						<p class="text-text-primary font-medium">{{ t(jobStateKey(reembedJob)) }}</p>
						<p class="mt-0.5 text-text-secondary">
							{{
								t(`${K}.job.progress`, {
									embedded: formatNumber(reembedJob.embeddedCount),
									scanned: formatNumber(reembedJob.scannedCount),
									table: t(`${K}.coverage.tables.${reembedJob.phase}`),
								})
							}}
						</p>
						<div class="mt-2 flex flex-wrap gap-2">
							<UiButton
								v-if="reembedJob.status === 'paused'"
								type="button"
								variant="secondary"
								size="sm"
								:disabled="spaces.isBusy.value || resumeBlock !== null"
								data-testid="ai-embedding-reembed-resume"
								@click="resume(reembedJob)"
							>
								{{ t(`${K}.job.resume`) }}
							</UiButton>
							<UiButton
								type="button"
								variant="ghost"
								size="sm"
								:disabled="spaces.isBusy.value"
								@click="spaces.cancel(reembedJob)"
							>
								{{ t(`${K}.job.cancel`) }}
							</UiButton>
						</div>
						<p
							v-if="reembedJob.status === 'paused' && resumeBlock"
							class="mt-2 text-xs text-text-tertiary"
							data-testid="ai-embedding-reembed-resume-blocker"
						>
							{{ t(resumeBlock) }}
						</p>
					</div>

					<div v-else class="mt-3 flex flex-wrap items-center gap-3">
						<UiButton
							type="button"
							variant="secondary"
							size="sm"
							:disabled="spaces.isBusy.value || blocker !== null || candidates.count === 0"
							data-testid="ai-embedding-reembed-start"
							@click="startReembed"
						>
							{{
								t(candidates.isExact ? `${K}.reembed.startExact` : `${K}.reembed.start`, {
									count: formatNumber(candidates.count),
								})
							}}
						</UiButton>
						<p
							v-if="blocker"
							class="text-xs text-text-tertiary"
							data-testid="ai-embedding-reembed-blocker"
						>
							{{ t(blocker) }}
						</p>
						<p
							v-else-if="candidates.count === 0"
							class="text-xs text-text-tertiary"
							data-testid="ai-embedding-reembed-nothing"
						>
							{{
								candidates.isExact ? t(`${K}.reembed.nothingEligible`) : t(`${K}.reembed.nothing`)
							}}
							<template v-if="candidates.skipped">
								{{ t(`${K}.reembed.skipped`, { count: formatNumber(candidates.skipped) }) }}
							</template>
						</p>
					</div>

					<p
						v-if="!reembedJob && lastReembed"
						class="mt-2 text-xs text-text-tertiary"
						data-testid="ai-embedding-reembed-last"
					>
						{{
							t(`${K}.job.last`, {
								state: t(jobStateKey(lastReembed)),
								date: formatDateTime(lastReembed.finishedAt ?? lastReembed.updatedAt),
								embedded: formatNumber(lastReembed.embeddedCount),
							})
						}}
						<span v-if="lastReembed.lastError" class="block text-error">
							{{ lastReembed.lastError }}
						</span>
					</p>
				</section>

				<SettingsAiEmbeddingAttestation
					v-if="isAttestationOffered(status) || status.attestations.length > 0"
					:spaces="spaces"
					:status="status"
				/>

				<SettingsAiEmbeddingRebuild :spaces="spaces" :status="status" />
			</div>
		</UiQueryBoundary>

		<UiConfirmationDialog
			:open="confirmation.pending.value !== null"
			:title="confirmation.pending.value?.title"
			:description="confirmation.pending.value?.body"
			:confirm-text="confirmation.pending.value?.confirmText"
			:is-loading="spaces.isBusy.value"
			@update:open="confirmation.dismiss"
			@confirm="confirmation.confirm"
		/>
	</UiCard>
</template>
