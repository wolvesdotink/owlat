<script setup lang="ts">
/**
 * The account export's manifest and progress bar (idea 67).
 *
 * Before the run it answers "what is in this file?" — every resource by name,
 * with a row count where one could be known cheaply. During the run it answers
 * "is this still going?" — a bar over rows written, which for a large mailbox is
 * the difference between a working export and an apparently hung app.
 *
 * A resource counted only as it streams shows a dash rather than a zero: an
 * unknown count and an empty resource must not look the same.
 */
import type { AccountExportManifestRow } from '~/utils/accountExportProgress';

const props = defineProps<{
	rows: AccountExportManifestRow[];
	isLoading: boolean;
	isExporting: boolean;
	rowsWritten: number;
	/** `null` renders an indeterminate bar (no denominator yet). */
	percent: number | null;
}>();

const { t, locale } = useI18n();

function formatCount(value: number): string {
	return new Intl.NumberFormat(locale.value).format(value);
}

function countLabel(row: AccountExportManifestRow): string {
	if (row.count === null) return '—';
	return row.isCapped
		? t('components.preferences.preferencesExportManifest.moreThan', {
				count: formatCount(row.count),
			})
		: formatCount(row.count);
}

const barWidth = computed(() => `${props.percent ?? 100}%`);
</script>

<template>
	<div class="mt-4 rounded-lg border border-border-subtle bg-bg-surface/50 p-4">
		<h4 class="text-xs font-medium text-text-secondary uppercase tracking-wide">
			{{ t('components.preferences.preferencesExportManifest.title') }}
		</h4>

		<p v-if="isLoading" class="text-xs text-text-tertiary mt-2">
			{{ t('components.preferences.preferencesExportManifest.loading') }}
		</p>
		<p v-else-if="rows.length === 0" class="text-xs text-text-tertiary mt-2">
			{{ t('components.preferences.preferencesExportManifest.unavailable') }}
		</p>
		<dl v-else class="mt-2 grid gap-1 sm:grid-cols-2">
			<div
				v-for="row in rows"
				:key="row.resource"
				class="flex items-baseline justify-between gap-3 text-xs"
			>
				<dt class="text-text-tertiary truncate">{{ t(row.labelKey) }}</dt>
				<dd class="text-text-secondary tabular-nums">{{ countLabel(row) }}</dd>
			</div>
		</dl>

		<p v-if="!isLoading && rows.length > 0" class="text-[11px] text-text-tertiary mt-2">
			{{ t('components.preferences.preferencesExportManifest.uncountedNote') }}
		</p>

		<div v-if="isExporting" class="mt-3 space-y-1">
			<div
				class="h-2 rounded-full bg-bg-base overflow-hidden"
				role="progressbar"
				:aria-valuenow="percent ?? undefined"
				aria-valuemin="0"
				aria-valuemax="100"
				:aria-label="t('components.preferences.preferencesExportManifest.progressLabel')"
			>
				<div
					class="h-full bg-brand transition-[width] duration-300 motion-reduce:transition-none"
					:class="percent === null ? 'animate-pulse motion-reduce:animate-none' : ''"
					:style="{ width: barWidth }"
				/>
			</div>
			<p class="text-xs text-text-tertiary" aria-live="polite">
				{{
					t('components.preferences.preferencesExportManifest.progress', {
						count: formatCount(rowsWritten),
					})
				}}
			</p>
		</div>
	</div>
</template>
