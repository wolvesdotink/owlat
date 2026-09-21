<script setup lang="ts">
/**
 * "Import from a file" — the second half of the migration wizard (idea 50).
 *
 * The rest of `/dashboard/postbox/migrate` imports a mailbox we can log into.
 * That is no help to the largest group of people who want to leave a provider:
 * the ones whose account is already closed, or who were told to "download your
 * data" and now hold a Gmail Takeout `.mbox` and no server to point at. This
 * card takes the file.
 *
 * Deliberately OUTSIDE the `mail.external` gate the wizard's IMAP half sits
 * behind: importing a file needs no external-mailbox sync, and a deployment
 * with that feature turned off can still take someone's archive.
 */
import {
	ARCHIVE_IMPORT_ACCEPT,
	archiveImportSummary,
	type ArchiveImportJob,
} from '~/utils/postboxArchiveImport';

const { t, locale } = useI18n();
const {
	job,
	isRunning,
	isBusy,
	isUploading,
	isCancelling,
	isImportingFilters,
	untranslatedFilters,
	importFile,
	importFilters,
	cancelImport,
} = useArchiveImport();

const fileInput = ref<HTMLInputElement | null>(null);
const filterInput = ref<HTMLInputElement | null>(null);

function formatCount(value: number): string {
	return new Intl.NumberFormat(locale.value).format(value);
}

/** The summary line, with its counts localized at the render boundary. */
function summaryOf(current: ArchiveImportJob): string {
	const summary = archiveImportSummary(current);
	const params = Object.fromEntries(
		Object.entries(summary.params ?? {}).map(([key, value]) => [
			key,
			typeof value === 'number' ? formatCount(value) : value,
		])
	);
	return t(summary.key, params);
}

async function onFileChange(event: Event) {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	// Clear the input either way: picking the same file twice in a row must
	// still fire a change event (a retry after a rejection is the common case).
	input.value = '';
	if (file) await importFile(file);
}

async function onFilterFileChange(event: Event) {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	input.value = '';
	if (file) await importFilters(file);
}
</script>

<template>
	<section class="card !p-0">
		<header class="px-5 py-4 border-b border-border-subtle flex items-center gap-3">
			<UiIconBox icon="lucide:file-up" size="sm" variant="surface" rounded="lg" />
			<div class="min-w-0">
				<h2 class="font-semibold text-text-primary">
					{{ t('components.postbox.postboxArchiveImportCard.title') }}
				</h2>
				<p class="text-sm text-text-secondary">
					{{ t('components.postbox.postboxArchiveImportCard.subtitle') }}
				</p>
			</div>
		</header>

		<div class="px-5 py-4 space-y-4">
			<p class="text-sm text-text-secondary">
				{{ t('components.postbox.postboxArchiveImportCard.body') }}
			</p>

			<div v-if="job" class="space-y-2">
				<div class="flex items-center justify-between gap-4 text-sm">
					<span class="font-medium text-text-primary truncate">{{ job.filename }}</span>
					<span class="text-text-tertiary shrink-0">{{ job.percent }}%</span>
				</div>
				<div
					class="h-2 rounded-full bg-bg-surface overflow-hidden"
					role="progressbar"
					:aria-valuenow="job.percent"
					aria-valuemin="0"
					aria-valuemax="100"
					:aria-label="t('components.postbox.postboxArchiveImportCard.progressLabel')"
				>
					<div
						class="h-full bg-brand transition-[width] duration-300 motion-reduce:transition-none"
						:style="{ width: `${job.percent}%` }"
					/>
				</div>
				<p class="text-xs text-text-tertiary">{{ summaryOf(job) }}</p>
				<p v-if="job.labelsCreated > 0" class="text-xs text-text-tertiary">
					{{
						t('components.postbox.postboxArchiveImportCard.labelsCreated', {
							count: formatCount(job.labelsCreated),
						})
					}}
				</p>
				<p v-if="job.status === 'failed' && job.lastError" class="text-xs text-error">
					{{ job.lastError }}
				</p>
			</div>

			<div class="flex items-center gap-3">
				<input
					ref="fileInput"
					type="file"
					class="sr-only"
					:accept="ARCHIVE_IMPORT_ACCEPT"
					:disabled="isBusy"
					@change="onFileChange"
				/>
				<UiButton
					variant="secondary"
					size="sm"
					class="gap-2"
					:disabled="isBusy"
					@click="fileInput?.click()"
				>
					<Icon
						v-if="isUploading"
						name="lucide:loader-2"
						class="w-4 h-4 animate-spin motion-reduce:animate-none"
					/>
					<Icon v-else name="lucide:upload" class="w-4 h-4" />
					{{
						isUploading
							? t('components.postbox.postboxArchiveImportCard.uploading')
							: t('components.postbox.postboxArchiveImportCard.chooseFile')
					}}
				</UiButton>
				<UiButton
					v-if="isRunning"
					variant="ghost"
					size="sm"
					:disabled="isCancelling"
					@click="cancelImport"
				>
					{{ t('components.postbox.postboxArchiveImportCard.cancel') }}
				</UiButton>
			</div>

			<p class="text-xs text-text-tertiary">
				{{ t('components.postbox.postboxArchiveImportCard.help') }}
			</p>

			<!--
				Filters, separately. An archive without the rules that sorted it is a
				pile; Gmail exports the two as different files, so the card takes them
				as different files too.
			-->
			<div class="pt-4 border-t border-border-subtle space-y-2">
				<h3 class="font-medium text-sm">
					{{ t('components.postbox.postboxArchiveImportCard.filtersTitle') }}
				</h3>
				<p class="text-xs text-text-tertiary">
					{{ t('components.postbox.postboxArchiveImportCard.filtersHelp') }}
				</p>
				<input
					ref="filterInput"
					type="file"
					class="sr-only"
					accept=".xml"
					:disabled="isImportingFilters"
					@change="onFilterFileChange"
				/>
				<UiButton
					variant="secondary"
					size="sm"
					class="gap-2"
					:disabled="isImportingFilters"
					@click="filterInput?.click()"
				>
					<Icon
						v-if="isImportingFilters"
						name="lucide:loader-2"
						class="w-4 h-4 animate-spin motion-reduce:animate-none"
					/>
					<Icon v-else name="lucide:filter" class="w-4 h-4" />
					{{ t('components.postbox.postboxArchiveImportCard.filtersAction') }}
				</UiButton>
				<div v-if="untranslatedFilters.length > 0" class="text-xs text-text-tertiary space-y-1">
					<p>
						{{
							t('components.postbox.postboxArchiveImportCard.filtersUntranslated', {
								count: formatCount(untranslatedFilters.length),
							})
						}}
					</p>
					<ul class="list-disc pl-4 space-y-0.5">
						<li v-for="(rule, index) in untranslatedFilters" :key="index">
							{{ rule.description }} — {{ t(rule.reasonKey) }}
						</li>
					</ul>
				</div>
			</div>
		</div>
	</section>
</template>
