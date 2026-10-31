<script setup lang="ts">
import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';

const props = defineProps<{
	/** The provider's display name. */
	integrationName: string;
	importProgress:
		| FunctionReturnType<typeof api.integrationImports.walker.getImportProgress>
		| undefined;
}>();

const { t, locale } = useI18n();

const formatCount = (value: number) => new Intl.NumberFormat(locale.value).format(value);

// Computed progress percentage
const progressPercent = computed(() => {
	const p = props.importProgress;
	if (!p || p.status !== 'running') return 0;
	const processed = p.imported + p.updated + p.skipped + p.failed;
	if (p.totalEstimate && p.totalEstimate > 0) {
		return Math.min(Math.round((processed / p.totalEstimate) * 100), 99);
	}
	// Stripe doesn't provide total — show indeterminate-ish progress
	return processed > 0 ? Math.min(processed, 99) : 5;
});

// Computed progress text
const progressText = computed(() => {
	const p = props.importProgress;
	if (!p || p.status !== 'running') return '';
	const processed = p.imported + p.updated + p.skipped + p.failed;
	if (p.provider === 'mandrill') {
		const carried = p.suppressionCounts;
		const seen = carried
			? carried.bouncedHard +
				carried.bouncedSoft +
				carried.complained +
				carried.manual +
				carried.unsubscribed +
				carried.alreadyBlocked +
				carried.alreadyUnsubscribed +
				carried.noContact +
				carried.skipped
			: 0;
		return p.totalEstimate
			? t('components.contacts.integrationImportModal.progress.reviewedOfTotal', {
					seen: formatCount(seen),
					total: formatCount(p.totalEstimate),
				})
			: t('components.contacts.integrationImportModal.progress.reviewed', {
					seen: formatCount(seen),
				});
	}
	if (p.totalEstimate) {
		return t('components.contacts.integrationImportModal.progress.importedOfTotal', {
			processed: formatCount(processed),
			total: formatCount(p.totalEstimate),
		});
	}
	return t('components.contacts.integrationImportModal.progress.imported', {
		processed: formatCount(processed),
	});
});
</script>

<template>
	<div class="py-8">
		<div class="flex flex-col items-center gap-6">
			<div class="relative">
				<div class="w-20 h-20 rounded-full border-4 border-bg-surface" />
				<div
					class="absolute inset-0 w-20 h-20 rounded-full border-4 border-brand border-t-transparent animate-spin motion-reduce:animate-none"
				/>
			</div>
			<div class="text-center">
				<p class="text-lg font-medium text-text-primary">
					{{
						t('components.contacts.integrationImportModal.importing.title', {
							provider: integrationName,
						})
					}}
				</p>
				<p class="text-sm text-text-tertiary mt-1">
					{{ progressText || t('components.contacts.integrationImportModal.importing.starting') }}
				</p>
			</div>
			<UiProgressBar
				class="max-w-xs"
				size="sm"
				:value="progressPercent"
				:aria-label="t('components.contacts.integrationImportModal.importing.progressLabel')"
			/>
			<p class="text-xs text-text-tertiary">
				{{ t('components.contacts.integrationImportModal.importing.background') }}
			</p>
		</div>
	</div>
</template>
