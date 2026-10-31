<script setup lang="ts">
import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';

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
				<Icon
					:name="importProgress?.status === 'failed' ? 'lucide:alert-triangle' : 'lucide:check'"
					:class="['w-8 h-8', importProgress?.status === 'failed' ? 'text-error' : 'text-success']"
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
			<div class="p-4 rounded-lg bg-bg-surface text-center">
				<p class="text-2xl font-medium tracking-[-0.02em] text-success">
					{{ importProgress?.imported || 0 }}
				</p>
				<p class="text-xs text-text-tertiary mt-1">
					{{ t('components.contacts.integrationImportModal.complete.imported') }}
				</p>
			</div>
			<div class="p-4 rounded-lg bg-bg-surface text-center">
				<p class="text-2xl font-medium tracking-[-0.02em] text-brand">
					{{ importProgress?.updated || 0 }}
				</p>
				<p class="text-xs text-text-tertiary mt-1">
					{{ t('components.contacts.integrationImportModal.complete.updated') }}
				</p>
			</div>
			<div class="p-4 rounded-lg bg-bg-surface text-center">
				<p class="text-2xl font-medium tracking-[-0.02em] text-text-secondary">
					{{ importProgress?.skipped || 0 }}
				</p>
				<p class="text-xs text-text-tertiary mt-1">
					{{ t('components.contacts.integrationImportModal.complete.skipped') }}
				</p>
			</div>
			<div class="p-4 rounded-lg bg-bg-surface text-center">
				<p class="text-2xl font-medium tracking-[-0.02em] text-error">
					{{ importProgress?.failed || 0 }}
				</p>
				<p class="text-xs text-text-tertiary mt-1">
					{{ t('components.contacts.integrationImportModal.complete.failed') }}
				</p>
			</div>
		</div>
		<!-- Suppression carry-over -->
		<div v-if="suppressionSummary" class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
			<div class="p-4 rounded-lg bg-bg-surface text-center">
				<p class="text-2xl font-medium tracking-[-0.02em] text-warning">
					{{ suppressionSummary.blocked }}
				</p>
				<p class="text-xs text-text-tertiary mt-1">
					{{ t('components.contacts.integrationImportModal.complete.suppressed') }}
				</p>
			</div>
			<div class="p-4 rounded-lg bg-bg-surface text-center">
				<p class="text-2xl font-medium tracking-[-0.02em] text-brand">
					{{ suppressionSummary.unsubscribed }}
				</p>
				<p class="text-xs text-text-tertiary mt-1">
					{{ t('components.contacts.integrationImportModal.complete.unsubscribed') }}
				</p>
			</div>
			<div class="p-4 rounded-lg bg-bg-surface text-center">
				<p class="text-2xl font-medium tracking-[-0.02em] text-text-secondary">
					{{ suppressionSummary.alreadySuppressed }}
				</p>
				<p class="text-xs text-text-tertiary mt-1">
					{{ t('components.contacts.integrationImportModal.complete.alreadySuppressed') }}
				</p>
			</div>
			<div class="p-4 rounded-lg bg-bg-surface text-center">
				<p class="text-2xl font-medium tracking-[-0.02em] text-text-secondary">
					{{ suppressionSummary.skipped }}
				</p>
				<p class="text-xs text-text-tertiary mt-1">
					{{ t('components.contacts.integrationImportModal.complete.notApplicable') }}
				</p>
			</div>
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
