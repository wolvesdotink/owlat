<script setup lang="ts">
import CsvImportPreviewIssues from './PreviewIssues.vue';

const props = defineProps<{
	csvImport: ReturnType<typeof useCsvImport>;
	/** How the rows get their topic, or `null` when none is assigned. */
	topicAssignmentSummary: string | null;
}>();

const showValidationDetails = defineModel<boolean>('showDetails', { required: true });

const { t } = useI18n();

// Local handle on the validation result so the warnings panel reads its fields
// without a non-null assertion on every line; the panel's v-if narrows this to
// non-null before any field is touched.
const validationResult = computed(() => props.csvImport.validation.value);

// Distinct custom-property keys mapped in this import (for the preview summary).
const mappedPropertyKeys = computed(() => props.csvImport.getMappedPropertyKeys());
</script>

<template>
	<div>
		<!-- Validation Summary Cards -->
		<div v-if="validationResult" class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
			<div class="p-3 rounded-lg bg-success/10 border border-success/20">
				<p class="text-2xl font-medium tracking-[-0.02em] text-success">
					{{ validationResult.validCount }}
				</p>
				<p class="text-xs text-success/80">
					{{ t('components.contacts.csvImportModal.preview.validContacts') }}
				</p>
			</div>
			<div
				class="p-3 rounded-lg"
				:class="
					validationResult.invalidEmails.length > 0
						? 'bg-warning/10 border border-warning/20'
						: 'bg-bg-surface border border-border-subtle'
				"
			>
				<p
					class="text-2xl font-medium tracking-[-0.02em]"
					:class="validationResult.invalidEmails.length > 0 ? 'text-warning' : 'text-text-tertiary'"
				>
					{{ validationResult.invalidEmails.length }}
				</p>
				<p
					class="text-xs"
					:class="
						validationResult.invalidEmails.length > 0 ? 'text-warning/80' : 'text-text-tertiary'
					"
				>
					{{ t('components.contacts.csvImportModal.preview.invalidEmails') }}
				</p>
			</div>
			<div
				class="p-3 rounded-lg"
				:class="
					validationResult.duplicateEmails.length > 0
						? 'bg-warning/10 border border-warning/20'
						: 'bg-bg-surface border border-border-subtle'
				"
			>
				<p
					class="text-2xl font-medium tracking-[-0.02em]"
					:class="
						validationResult.duplicateEmails.length > 0 ? 'text-warning' : 'text-text-tertiary'
					"
				>
					{{ validationResult.duplicateEmails.length }}
				</p>
				<p
					class="text-xs"
					:class="
						validationResult.duplicateEmails.length > 0 ? 'text-warning/80' : 'text-text-tertiary'
					"
				>
					{{ t('components.contacts.csvImportModal.preview.duplicates') }}
				</p>
			</div>
			<div
				class="p-3 rounded-lg"
				:class="
					validationResult.missingEmails.length > 0
						? 'bg-error-subtle border border-error/20'
						: 'bg-bg-surface border border-border-subtle'
				"
			>
				<p
					class="text-2xl font-medium tracking-[-0.02em]"
					:class="validationResult.missingEmails.length > 0 ? 'text-error' : 'text-text-tertiary'"
				>
					{{ validationResult.missingEmails.length }}
				</p>
				<p
					class="text-xs"
					:class="
						validationResult.missingEmails.length > 0 ? 'text-error/80' : 'text-text-tertiary'
					"
				>
					{{ t('components.contacts.csvImportModal.preview.missingEmails') }}
				</p>
			</div>
		</div>

		<!-- No valid contacts error -->
		<div
			v-if="!csvImport.canImport.value"
			class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20 flex items-start gap-3"
		>
			<Icon name="lucide:alert-circle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
			<p class="text-sm text-error">
				{{ t('components.contacts.csvImportModal.preview.noValidContacts') }}
			</p>
		</div>

		<!-- Preview Table -->
		<div class="mb-4">
			<p class="text-sm text-text-secondary mb-2">
				{{
					t('components.contacts.csvImportModal.preview.rowsPreview', {
						shown: Math.min(5, csvImport.totalRowCount.value),
						total: csvImport.totalRowCount.value,
					})
				}}
			</p>
		</div>
		<div class="overflow-x-auto rounded-lg border border-border-subtle">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-border-subtle bg-bg-surface">
						<th class="text-left px-4 py-2 font-medium text-text-secondary w-8">
							<Icon name="lucide:shield-check" class="w-4 h-4" />
						</th>
						<th class="text-left px-4 py-2 font-medium text-text-secondary">
							{{ t('common.email') }}
							<span
								v-if="csvImport.emailSourceColumn.value"
								class="block text-xs font-normal text-text-tertiary"
							>
								{{
									t('components.contacts.csvImportModal.preview.emailSource', {
										column: csvImport.emailSourceColumn.value,
									})
								}}
							</span>
						</th>
						<th class="text-left px-4 py-2 font-medium text-text-secondary">
							{{ t('components.contacts.csvImportModal.preview.firstName') }}
						</th>
						<th class="text-left px-4 py-2 font-medium text-text-secondary">
							{{ t('components.contacts.csvImportModal.preview.lastName') }}
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="prepared in csvImport.previewRows.value"
						:key="prepared.row"
						class="border-b border-border-subtle last:border-b-0"
					>
						<td class="px-4 py-2">
							<Icon
								v-if="prepared.status === 'valid'"
								name="lucide:check-circle"
								class="w-4 h-4 text-success"
							/>
							<Icon
								v-else-if="prepared.status === 'missing'"
								name="lucide:x-circle"
								class="w-4 h-4 text-error"
							/>
							<Icon v-else name="lucide:alert-triangle" class="w-4 h-4 text-warning" />
						</td>
						<td class="px-4 py-2 text-text-primary">
							{{ prepared.contact.email || '—' }}
						</td>
						<td class="px-4 py-2 text-text-secondary">
							{{ prepared.contact.firstName || '—' }}
						</td>
						<td class="px-4 py-2 text-text-secondary">
							{{ prepared.contact.lastName || '—' }}
						</td>
					</tr>
				</tbody>
			</table>
		</div>

		<!-- Expandable Error Details -->
		<CsvImportPreviewIssues
			v-if="csvImport.hasValidationWarnings.value"
			v-model:open="showValidationDetails"
			:validation-result="validationResult"
		/>

		<!-- Import Summary -->
		<div class="mt-4 p-4 rounded-lg bg-bg-surface">
			<h4 class="text-sm font-medium text-text-primary mb-2">
				{{ t('components.contacts.csvImportModal.preview.summaryTitle') }}
			</h4>
			<ul class="text-sm text-text-secondary space-y-1">
				<li>
					{{
						t('components.contacts.csvImportModal.preview.summaryCount', {
							valid: csvImport.validContactCount.value,
							total: csvImport.totalRowCount.value,
						})
					}}
				</li>
				<li>
					{{
						csvImport.handleDuplicates.value === 'skip'
							? t('components.contacts.csvImportModal.preview.summaryDuplicatesSkipped')
							: t('components.contacts.csvImportModal.preview.summaryDuplicatesUpdated')
					}}
				</li>
				<li v-if="topicAssignmentSummary">
					<Icon name="lucide:list" class="w-3.5 h-3.5 inline-block mr-1 text-brand" />
					{{ topicAssignmentSummary }}
				</li>
				<li v-if="mappedPropertyKeys.length > 0">
					<Icon name="lucide:tag" class="w-3.5 h-3.5 inline-block mr-1 text-brand" />
					{{
						t(
							'components.contacts.csvImportModal.preview.summaryProperties',
							{ count: mappedPropertyKeys.length, keys: mappedPropertyKeys.join(', ') },
							mappedPropertyKeys.length
						)
					}}
				</li>
			</ul>
		</div>
	</div>
</template>
