<script setup lang="ts">
import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';
import { CheckIcon, CircleWarningIcon, TriangleWarningIcon } from '@coolicons/vue';

const props = defineProps<{
	importProgress:
		| FunctionReturnType<typeof api.integrationImports.walker.getImportProgress>
		| undefined;
	/** Suppression-only runs have no contacts to report. */
	isSuppressionOnly: boolean;
}>();

const { t } = useI18n();

const suppressionSummary = computed(() => {
	const counts = props.importProgress?.suppressionCounts;
	if (!counts) return null;
	const blocked = counts.bouncedHard + counts.bouncedSoft + counts.complained + counts.manual;
	return {
		blocked,
		unsubscribed: counts.unsubscribed,
		alreadySuppressed: counts.alreadyBlocked + counts.alreadyUnsubscribed,
		skipped: counts.skipped + counts.noContact,
	};
});
</script>

<template>
	<div class="py-4">
		<div class="flex flex-col items-center gap-4 mb-6">
			<div
				:class="[
					'p-3 rounded-full',
					importProgress?.status === 'failed' ? 'bg-error/10' : 'bg-success/10',
				]"
			>
				<component
					:is="importProgress?.status === 'failed' ? TriangleWarningIcon : CheckIcon"
					:class="['w-8 h-8', importProgress?.status === 'failed' ? 'text-error' : 'text-success']"
					size="1em"
				/>
			</div>
			<p class="text-lg font-medium text-text-primary">
				{{
					importProgress?.status === 'failed'
						? t('components.contacts.integrationImportModal.complete.failedTitle')
						: t('components.contacts.integrationImportModal.complete.title')
				}}
			</p>
		</div>
		<div v-if="!isSuppressionOnly" class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
			<UiStatCard
				:value="importProgress?.imported || 0"
				:label="t('components.contacts.integrationImportModal.complete.imported')"
				variant="success"
			/>
			<UiStatCard
				:value="importProgress?.updated || 0"
				:label="t('components.contacts.integrationImportModal.complete.updated')"
			/>
			<UiStatCard
				:value="importProgress?.skipped || 0"
				:label="t('components.contacts.integrationImportModal.complete.skipped')"
				variant="secondary"
			/>
			<!-- Red only when something actually failed. -->
			<UiStatCard
				:value="importProgress?.failed || 0"
				:label="t('components.contacts.integrationImportModal.complete.failed')"
				:variant="(importProgress?.failed || 0) > 0 ? 'error' : 'secondary'"
			/>
		</div>
		<!-- An import never lifts an opt-out, so say how many contacts it left alone. -->
		<div
			v-if="!isSuppressionOnly && importProgress?.keptUnsubscribed"
			class="mb-6 p-3 rounded-lg bg-bg-surface border border-border-default flex items-center gap-3"
			data-testid="kept-unsubscribed"
		>
			<CircleWarningIcon class="w-5 h-5 text-text-tertiary shrink-0" />
			<p class="text-sm text-text-secondary">
				{{
					t(
						'components.contacts.integrationImportModal.complete.keptUnsubscribed',
						{ count: importProgress.keptUnsubscribed },
						importProgress.keptUnsubscribed
					)
				}}
			</p>
		</div>
		<!-- Suppression carry-over -->
		<div v-if="suppressionSummary" class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
			<UiStatCard
				:value="suppressionSummary.blocked"
				:label="t('components.contacts.integrationImportModal.complete.suppressed')"
				variant="warning"
			/>
			<UiStatCard
				:value="suppressionSummary.unsubscribed"
				:label="t('components.contacts.integrationImportModal.complete.unsubscribed')"
			/>
			<UiStatCard
				:value="suppressionSummary.alreadySuppressed"
				:label="t('components.contacts.integrationImportModal.complete.alreadySuppressed')"
				variant="secondary"
			/>
			<UiStatCard
				:value="suppressionSummary.skipped"
				:label="t('components.contacts.integrationImportModal.complete.notApplicable')"
				variant="secondary"
			/>
		</div>

		<div
			v-if="importProgress?.errors && importProgress.errors.length > 0"
			class="p-4 rounded-lg bg-error-subtle border border-error/20"
		>
			<h4 class="text-sm font-medium text-error mb-2">
				{{ t('components.contacts.integrationImportModal.complete.errorsTitle') }}
			</h4>
			<ul class="text-sm text-error/80 space-y-1">
				<li v-for="(err, index) in importProgress.errors.slice(0, 5)" :key="index">
					{{ err }}
				</li>
			</ul>
		</div>
	</div>
</template>
