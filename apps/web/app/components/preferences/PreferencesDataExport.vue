<script setup lang="ts">
import type { AccountExportManifestRow } from '~/utils/accountExportProgress';
import { DownloadIcon, FileCodeIcon, TableIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

/**
 * The export card: the JSON export with its manifest and progress, and the
 * contacts CSV. Presentational: the page's useAccountExport runs both.
 */
defineProps<{
	isExportingJson: boolean;
	isExportingCsv: boolean;
	/** The contacts CSV needs an active workspace. */
	canExportCsv: boolean;
	manifest: AccountExportManifestRow[];
	isManifestLoading: boolean;
	exportedRows: number;
	exportPercent: number | null;
}>();

const emit = defineEmits<{ exportJson: []; exportCsv: [] }>();

const { t } = useI18n();
</script>

<template>
	<div class="card p-0 overflow-hidden">
		<div class="px-6 py-4 border-b border-border-subtle">
			<div class="flex items-center gap-3">
				<UiIconBox :icon="DownloadIcon" size="sm" variant="surface" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">
						{{ t('dashboard.preferences.account.exportTitle') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('dashboard.preferences.account.exportSubtitle') }}
					</p>
				</div>
			</div>
		</div>

		<div class="p-6">
			<p class="text-text-secondary text-sm mb-6">
				{{ t('dashboard.preferences.account.exportBody') }}
			</p>

			<div class="grid gap-4 sm:grid-cols-2">
				<!-- JSON Export -->
				<div class="card p-5 bg-bg-surface/50">
					<div class="flex items-start gap-4">
						<UiIconBox :icon="FileCodeIcon" size="lg" variant="brand" rounded="lg" />
						<div class="flex-1">
							<h3 class="font-medium text-text-primary mb-1">
								{{ t('dashboard.preferences.account.exportJsonTitle') }}
							</h3>
							<p class="text-xs text-text-tertiary mb-3">
								{{ t('dashboard.preferences.account.exportJsonDescription') }}
							</p>
							<UiButton
								variant="secondary"
								size="sm"
								class="gap-2"
								:disabled="isExportingJson"
								@click="emit('exportJson')"
							>
								<SpinnerIcon v-if="isExportingJson" class="w-4 h-4" />
								<DownloadIcon v-else class="w-4 h-4" />
								{{
									isExportingJson
										? t('dashboard.preferences.account.exporting')
										: t('dashboard.preferences.account.exportJsonAction')
								}}
							</UiButton>
							<PreferencesExportManifest
								:rows="manifest"
								:is-loading="isManifestLoading"
								:is-exporting="isExportingJson"
								:rows-written="exportedRows"
								:percent="exportPercent"
							/>
						</div>
					</div>
				</div>

				<!-- CSV Export -->
				<div class="card p-5 bg-bg-surface/50">
					<div class="flex items-start gap-4">
						<UiIconBox :icon="TableIcon" size="lg" variant="brand" rounded="lg" />
						<div class="flex-1">
							<h3 class="font-medium text-text-primary mb-1">
								{{ t('dashboard.preferences.account.exportCsvTitle') }}
							</h3>
							<p class="text-xs text-text-tertiary mb-3">
								{{ t('dashboard.preferences.account.exportCsvDescription') }}
							</p>
							<UiButton
								variant="secondary"
								size="sm"
								class="gap-2"
								:disabled="isExportingCsv || !canExportCsv"
								@click="emit('exportCsv')"
							>
								<SpinnerIcon v-if="isExportingCsv" class="w-4 h-4" />
								<DownloadIcon v-else class="w-4 h-4" />
								{{
									isExportingCsv
										? t('dashboard.preferences.account.exporting')
										: t('dashboard.preferences.account.exportCsvAction')
								}}
							</UiButton>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
