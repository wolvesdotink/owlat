<script setup lang="ts">
import type { CsvImportCompletion } from '~/composables/csvImport/useCsvImportCompletion';
import { CheckIcon, ListUnorderedIcon, TriangleWarningIcon } from '@coolicons/vue';

const props = defineProps<{
	csvImport: ReturnType<typeof useCsvImport>;
	/** Created by the modal, whose footer acts on the same state. */
	completion: CsvImportCompletion;
	availableLists: Array<{ _id: string; name: string }>;
}>();

const { t } = useI18n();

const {
	errorRows,
	previewedErrorRows,
	hiddenErrorCount,
	notImportedCount,
	isIncomplete,
	failedCount,
	failedBatchRows,
	unsentRows,
	importedTopicId,
	isAddToTopicOpen,
	addToTopicId,
	isAddingToTopic,
	confirmAddToTopic,
} = props.completion;
</script>

<template>
	<div class="py-4">
		<div class="flex flex-col items-center gap-4 mb-6">
			<div v-if="isIncomplete" class="p-3 rounded-full bg-warning/10">
				<TriangleWarningIcon class="w-8 h-8 text-warning" :stroke-width="1.5" />
			</div>
			<div v-else class="p-3 rounded-full bg-success/10">
				<CheckIcon class="w-8 h-8 text-success" :stroke-width="1.5" />
			</div>
			<p class="text-lg font-medium text-text-primary">
				{{
					isIncomplete
						? t('components.contacts.csvImportModal.complete.incompleteTitle')
						: t('components.contacts.csvImportModal.complete.title')
				}}
			</p>
			<p v-if="isIncomplete" class="text-sm text-text-secondary text-center">
				{{
					t(
						'components.contacts.csvImportModal.complete.notImportedSummary',
						{
							processed: csvImport.totalRowCount.value - notImportedCount,
							total: csvImport.totalRowCount.value,
							count: notImportedCount,
						},
						notImportedCount
					)
				}}
			</p>
		</div>
		<div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
			<UiStatCard
				:value="csvImport.results.value?.imported || 0"
				:label="t('components.contacts.csvImportModal.complete.imported')"
				variant="success"
			/>
			<UiStatCard
				:value="csvImport.results.value?.updated || 0"
				:label="t('components.contacts.csvImportModal.complete.updated')"
				variant="default"
			/>
			<UiStatCard
				:value="csvImport.results.value?.skipped || 0"
				:label="t('components.contacts.csvImportModal.complete.skipped')"
				variant="secondary"
			/>
			<UiStatCard
				:value="failedCount"
				:label="t('components.contacts.csvImportModal.complete.failed')"
				variant="error"
			/>
		</div>
		<!-- A batch the backend did not commit: which rows, why, and that a retry
			 sends only those. -->
		<div
			v-if="isIncomplete"
			class="mb-4 p-4 rounded-lg bg-error-subtle border border-error/20"
			role="alert"
		>
			<h4 v-if="failedBatchRows.count > 0" class="text-sm font-medium text-error">
				{{
					t(
						'components.contacts.csvImportModal.complete.batchFailed',
						{ ...failedBatchRows, reason: csvImport.failedBatch.value?.reason ?? '' },
						failedBatchRows.count
					)
				}}
			</h4>
			<p v-if="unsentRows.count > 0" class="mt-1 text-sm text-error/80">
				{{ t('components.contacts.csvImportModal.complete.notSent', unsentRows, unsentRows.count) }}
			</p>
			<p class="mt-2 text-sm text-text-secondary">
				{{ t('components.contacts.csvImportModal.complete.retryHint') }}
			</p>
		</div>
		<div
			v-if="csvImport.results.value?.addedToList && csvImport.results.value.addedToList > 0"
			class="mb-4 p-3 rounded-lg bg-brand/5 border border-brand/20 flex items-center gap-3"
		>
			<ListUnorderedIcon class="w-5 h-5 text-brand shrink-0" />
			<p class="text-sm text-text-secondary">
				{{
					t(
						'components.contacts.csvImportModal.complete.addedToTopics',
						{ count: csvImport.results.value.addedToList },
						csvImport.results.value.addedToList
					)
				}}
			</p>
		</div>
		<!-- Add the rows that just landed to a topic, without leaving the modal. -->
		<div v-if="isAddToTopicOpen" class="mb-4 p-4 rounded-lg bg-bg-surface">
			<h4 class="text-sm font-medium text-text-primary mb-3">
				{{ t('components.contacts.csvImportModal.complete.addToTopicTitle') }}
			</h4>
			<select v-model="addToTopicId" class="input w-full">
				<option value="">
					{{ t('components.contacts.csvImportModal.complete.chooseTopic') }}
				</option>
				<option v-for="list in availableLists" :key="list._id" :value="list._id">
					{{ list.name }}
				</option>
			</select>
			<div class="mt-3 flex justify-end gap-3">
				<UiButton variant="secondary" :disabled="isAddingToTopic" @click="isAddToTopicOpen = false">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton :disabled="!addToTopicId" :loading="isAddingToTopic" @click="confirmAddToTopic()">
					{{ t('common.add') }}
				</UiButton>
			</div>
		</div>

		<div v-if="errorRows.length > 0" class="p-4 rounded-lg bg-error-subtle border border-error/20">
			<h4 class="text-sm font-medium text-error mb-2">
				{{
					t('components.contacts.csvImportModal.complete.errorsTitle', {
						count: errorRows.length,
					})
				}}
			</h4>
			<ul class="text-sm text-error/80 space-y-1">
				<li v-for="(error, index) in previewedErrorRows" :key="index">
					{{ error }}
				</li>
				<li v-if="hiddenErrorCount > 0" class="text-text-tertiary">
					{{
						t('components.contacts.csvImportModal.preview.andMore', {
							count: hiddenErrorCount,
						})
					}}
				</li>
			</ul>
		</div>

		<!-- No topic was in play, so there is nothing to filter the list by —
			 say that rather than opening an unchanged-looking page. -->
		<p v-if="!importedTopicId" class="mt-4 text-sm text-text-tertiary">
			{{ t('components.contacts.csvImportModal.complete.viewAllHint') }}
		</p>
	</div>
</template>
