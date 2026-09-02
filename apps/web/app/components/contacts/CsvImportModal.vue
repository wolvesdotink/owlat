<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { mappableFields, type ImportStep } from '~/composables/useCsvImport';
import { buildImportErrorsCsv, downloadCsv } from '~/utils/contactsCsv';

const props = defineProps<{
	csvImport: ReturnType<typeof useCsvImport>;
	topics?: Array<{ _id: string; name: string }>;
}>();

const emit = defineEmits<{
	import: [];
}>();

const { t } = useI18n();
const { showToast } = useToast();

const stepDescription = computed(() => {
	switch (props.csvImport.step.value) {
		case 'upload':
			return t('components.contacts.csvImportModal.steps.upload');
		case 'mapping':
			return t('components.contacts.csvImportModal.steps.mapping');
		case 'listMapping':
			return t('components.contacts.csvImportModal.steps.listMapping');
		case 'preview':
			return t('components.contacts.csvImportModal.steps.preview');
		case 'importing':
			return t('components.contacts.csvImportModal.steps.importing');
		case 'complete':
			return t('components.contacts.csvImportModal.steps.complete');
		default:
			return '';
	}
});

const canClose = computed(() => props.csvImport.step.value !== 'importing');

/**
 * The steps that hold work the operator cannot get back by re-opening the modal:
 * the parsed file plus a column mapping they may have spent minutes on. Closing
 * from any of them asks first — `close()` drops all of it, and `open()` resets,
 * so a stray backdrop click at `mapping` used to cost the whole upload silently.
 *
 * `upload` has nothing to lose and `complete` is already finished, so both close
 * straight away; `importing` is blocked by `canClose` and never reaches here.
 */
const DISCARDABLE_STEPS: ReadonlySet<ImportStep> = new Set(['mapping', 'listMapping', 'preview']);

const isConfirmingDiscard = ref(false);

/**
 * Every close path (X, Escape, backdrop, Cancel) routes through here. While the
 * prompt is up it is the top layer, so a second Escape dismisses the PROMPT and
 * leaves the wizard standing — never the other way round.
 */
const requestClose = () => {
	if (!canClose.value) return;
	if (isConfirmingDiscard.value) {
		isConfirmingDiscard.value = false;
		return;
	}
	if (DISCARDABLE_STEPS.has(props.csvImport.step.value)) {
		isConfirmingDiscard.value = true;
		return;
	}
	props.csvImport.close();
};

const confirmDiscard = () => {
	isConfirmingDiscard.value = false;
	props.csvImport.close();
};

const cancelDiscard = () => {
	isConfirmingDiscard.value = false;
};

const showValidationDetails = ref(false);

// Local handle on the validation result so the warnings panel reads its fields
// without a non-null assertion on every line; the panel's v-if narrows this to
// non-null before any field is touched.
const validationResult = computed(() => props.csvImport.validation.value);

const getRowValidationStatus = (rowNum: number): 'valid' | 'warning' | 'error' => {
	const v = validationResult.value;
	if (!v) return 'valid';
	if (v.missingEmails.includes(rowNum)) return 'error';
	if (v.invalidEmails.some((e) => e.row === rowNum)) return 'warning';
	if (v.duplicateEmails.some((e) => e.row === rowNum)) return 'warning';
	return 'valid';
};

const availableLists = computed(() => props.topics ?? []);

// Find list name by ID for display
const getListName = (listId: string): string => {
	return (
		availableLists.value.find((l) => l._id === listId)?.name ??
		t('components.contacts.csvImportModal.unknownList')
	);
};

// Distinct custom-property keys mapped in this import (for the preview summary).
const mappedPropertyKeys = computed(() => props.csvImport.getMappedPropertyKeys());

// Summary text for topic assignment in preview step
const topicAssignmentSummary = computed(() => {
	const mode = props.csvImport.listAssignmentMode.value;
	if (mode === 'global' && props.csvImport.selectedTopicId.value) {
		const name = getListName(props.csvImport.selectedTopicId.value);
		return t('components.contacts.csvImportModal.topicAssignment.global', { name });
	}
	if (mode === 'column') {
		const mapped = props.csvImport.mappedListCount.value;
		const skipped = props.csvImport.skippedListCount.value;
		return t(
			'components.contacts.csvImportModal.topicAssignment.column',
			{ mapped, skipped },
			mapped,
		);
	}
	return null;
});

// ── Complete step: where the import goes from here ──────────────────────────

/** How many failures the panel shows before deferring to the download. */
const ERROR_PREVIEW_LIMIT = 5;

const errorRows = computed(() => props.csvImport.results.value?.errors ?? []);
const previewedErrorRows = computed(() => errorRows.value.slice(0, ERROR_PREVIEW_LIMIT));
const hiddenErrorCount = computed(() => Math.max(0, errorRows.value.length - ERROR_PREVIEW_LIMIT));

/**
 * The full error list as a file. The on-screen list stays capped — a wall of
 * 200 red lines is not readable — but nothing that only exists in this modal is
 * allowed to die with it.
 */
const downloadErrorRows = () => {
	if (errorRows.value.length === 0) return;
	const stem = props.csvImport.selectedFile.value?.name.replace(/\.csv$/i, '').trim();
	downloadCsv(buildImportErrorsCsv(errorRows.value), `${stem || 'contacts-import'}-errors.csv`);
};

// A topic assigned after the fact, from the panel below — it becomes the
// "view imported" target the same way a topic chosen before the import does.
const assignedTopicId = ref<string | null>(null);

/**
 * The one place the rows that just landed are visible AS A SET: the topic they
 * were assigned to. The contacts list has no per-import filter (and no
 * route-driven search), so with no topic in play the honest answer is the whole
 * list — said out loud on screen rather than pretended away.
 */
const importedTopicId = computed<string | null>(() => {
	if (assignedTopicId.value) return assignedTopicId.value;
	if (props.csvImport.listAssignmentMode.value === 'global') {
		return props.csvImport.selectedTopicId.value;
	}
	if (props.csvImport.listAssignmentMode.value === 'column') {
		const mapped = [
			...new Set(Object.values(props.csvImport.listNameMapping.value).filter((id) => id !== null)),
		];
		// Several mapped topics have no single destination to open.
		return mapped.length === 1 ? mapped[0]! : null;
	}
	return null;
});

const viewImported = () => {
	const topicId = importedTopicId.value;
	props.csvImport.close();
	void navigateTo(
		topicId ? `/dashboard/audience/topics/${topicId}` : '/dashboard/audience/contacts'
	);
};

// ── Complete step: add the imported contacts to a topic ─────────────────────

const isAddToTopicOpen = ref(false);
const addToTopicId = ref('');

/**
 * The distinct addresses this import carried, in file order. The results only
 * carry counts, so the rows are re-derived from the parsed file — `close()` is
 * what clears it, and the complete step is still open.
 */
const importedEmails = computed(() => {
	const emailColumn = Object.entries(props.csvImport.columnMapping.value).find(
		([, field]) => field === 'email'
	)?.[0];
	if (emailColumn === undefined) return [];
	const index = parseInt(emailColumn, 10);
	const seen = new Set<string>();
	const emails: string[] = [];
	for (const row of props.csvImport.parsedData.value) {
		const email = row[index]?.trim();
		if (!email || seen.has(email.toLowerCase())) continue;
		seen.add(email.toLowerCase());
		emails.push(email);
	}
	return emails;
});

/** Same batch size the import itself uses, well under the backend's row cap. */
const ADD_TO_TOPIC_BATCH_SIZE = 100;

/**
 * Reuses the import's own topic-assignment path (`importBatch` with a topicId,
 * `skip` so no contact field is rewritten): the rows resolve to the contacts
 * that were just created and are subscribed to the topic. The bulk
 * `topics.addContacts` mutation is not usable here — it takes contact ids, and
 * an import returns counts, not ids.
 */
const { run: runAddToTopic, isLoading: isAddingToTopic } = useBackendOperation(
	api.contacts.contacts.importBatch,
	{ label: () => t('components.contacts.csvImportModal.complete.addToTopicOperation') }
);

const confirmAddToTopic = async () => {
	const topicId = addToTopicId.value;
	const emails = importedEmails.value;
	if (!topicId || emails.length === 0) return;

	let added = 0;
	for (let i = 0; i < emails.length; i += ADD_TO_TOPIC_BATCH_SIZE) {
		const outcome = await runAddToTopic({
			contacts: emails.slice(i, i + ADD_TO_TOPIC_BATCH_SIZE).map((email) => ({ email })),
			handleDuplicates: 'skip',
			topicId: topicId as Id<'topics'>,
		});
		// A failure has already been surfaced by the operation module.
		if (!outcome.ok) return;
		added += outcome.result.addedToList ?? 0;
	}

	assignedTopicId.value = topicId;
	isAddToTopicOpen.value = false;
	showToast(
		t(
			'components.contacts.csvImportModal.complete.addedToTopic',
			{ count: added, name: getListName(topicId) },
			added
		)
	);
};

// The composable resets its own state on `open()`; this is the modal's share of
// it, so an armed discard prompt or a finished import's follow-ups never greet
// the next one.
watch(
	() => props.csvImport.isOpen.value,
	(open) => {
		if (!open) return;
		isConfirmingDiscard.value = false;
		isAddToTopicOpen.value = false;
		addToTopicId.value = '';
		assignedTopicId.value = null;
	}
);
</script>

<template>
	<UiModal
		:open="csvImport.isOpen.value"
		size="2xl"
		:closable="canClose"
		:persistent="!canClose"
		@update:open="
			(v) => {
				if (!v) requestClose();
			}
		"
	>
		<!-- Header -->
		<div class="flex items-center gap-3 mb-6">
			<UiIconBox icon="lucide:file-spreadsheet" size="sm" variant="surface" rounded="lg" />
			<div>
				<h2 class="text-lg font-semibold text-text-primary">
					{{ t('components.contacts.csvImportModal.title') }}
				</h2>
				<p class="text-sm text-text-tertiary">{{ stepDescription }}</p>
			</div>
		</div>

		<!-- Error Alert -->
		<div
			v-if="csvImport.error.value"
			class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20 flex items-start gap-3"
		>
			<Icon name="lucide:alert-circle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
			<p class="text-sm text-error">{{ csvImport.error.value }}</p>
		</div>

		<!-- Discard guard: the top layer while it is up, so the wizard behind it
			 stays intact until the operator says otherwise. -->
		<div v-if="isConfirmingDiscard" class="py-4">
			<div class="flex flex-col items-center gap-4 text-center">
				<div class="p-3 rounded-full bg-warning/10">
					<Icon name="lucide:alert-triangle" class="w-8 h-8 text-warning" />
				</div>
				<p class="text-lg font-medium text-text-primary">
					{{ t('components.contacts.csvImportModal.discard.title') }}
				</p>
				<p class="text-sm text-text-secondary max-w-sm">
					{{ t('components.contacts.csvImportModal.discard.body') }}
				</p>
			</div>
		</div>

		<!-- Step 1: Upload -->
		<div v-else-if="csvImport.step.value === 'upload'">
			<!-- Function ref: a static dotted-path string ref ("csvImport.fileInputRef")
							never assigns the composable's ref object, so triggerFileInput() was a
							no-op and "click to browse" did nothing. Assign the element directly. -->
			<input
				:ref="
					(el) => {
						csvImport.fileInputRef.value = el as HTMLInputElement | null;
					}
				"
				type="file"
				accept=".csv"
				class="hidden"
				@change="csvImport.handleFileSelect"
			/>
			<div
				:ref="
					(el) => {
						csvImport.dropRootRef.value = el as HTMLElement | null;
					}
				"
				:class="[
					'border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer',
					csvImport.isDragging.value
						? 'border-brand bg-brand/5'
						: 'border-border-subtle hover:border-border-default',
				]"
				@click="csvImport.triggerFileInput()"
				@dragover="csvImport.handleDragOver"
				@dragleave="csvImport.handleDragLeave"
				@drop="csvImport.handleDrop"
			>
				<div class="flex flex-col items-center gap-4">
					<div class="p-4 rounded-full bg-bg-surface">
						<Icon name="lucide:upload" class="w-8 h-8 text-text-tertiary" />
					</div>
					<div>
						<p class="text-text-primary font-medium">
							{{ t('components.contacts.csvImportModal.upload.dropzone') }}
						</p>
						<p class="text-sm text-text-tertiary mt-1">
							{{ t('components.contacts.csvImportModal.upload.supports') }}
						</p>
					</div>
				</div>
			</div>
			<div class="mt-6 p-4 rounded-lg bg-bg-surface">
				<h4 class="text-sm font-medium text-text-primary mb-2">
					{{ t('components.contacts.csvImportModal.upload.tipsTitle') }}
				</h4>
				<ul class="text-sm text-text-secondary space-y-1">
					<li>{{ t('components.contacts.csvImportModal.upload.tips.headers') }}</li>
					<li>{{ t('components.contacts.csvImportModal.upload.tips.emailColumn') }}</li>
					<li>{{ t('components.contacts.csvImportModal.upload.tips.optionalColumns') }}</li>
					<li>{{ t('components.contacts.csvImportModal.upload.tips.customProperty') }}</li>
				</ul>
			</div>
		</div>

		<!-- Step 2: Mapping -->
		<div v-else-if="csvImport.step.value === 'mapping'">
			<div class="mb-4">
				<I18nT
					keypath="components.contacts.csvImportModal.mapping.found"
					tag="p"
					class="text-sm text-text-secondary"
					scope="global"
				>
					<template #count>
						<span class="text-text-primary font-medium">{{
							csvImport.totalRowCount.value
						}}</span>
					</template>
					<template #filename>
						<span class="text-text-primary font-medium">{{
							csvImport.selectedFile.value?.name
						}}</span>
					</template>
				</I18nT>
			</div>
			<div class="space-y-3 mb-6">
				<div
					v-for="(header, index) in csvImport.csvHeaders.value"
					:key="index"
					class="flex items-center gap-4 p-3 rounded-lg bg-bg-surface"
				>
					<div class="flex-1 min-w-0">
						<p class="text-sm font-medium text-text-primary truncate">{{ header }}</p>
						<p class="text-xs text-text-tertiary truncate">
							{{
								t('components.contacts.csvImportModal.mapping.sample', {
									value:
										csvImport.parsedData.value[0]?.[index] ||
										t('components.contacts.csvImportModal.emptyCell'),
								})
							}}
						</p>
					</div>
					<select
						v-model="csvImport.columnMapping.value[index]"
						class="input w-48 shrink-0"
						:disabled="
							csvImport.listAssignmentMode.value === 'global' &&
							csvImport.columnMapping.value[index] === 'topic'
						"
					>
						<option
							v-for="field in mappableFields"
							:key="field.value"
							:value="field.value"
							:disabled="
								field.value === 'topic' && csvImport.listAssignmentMode.value === 'global'
							"
						>
							{{ t(field.label) }}
						</option>
					</select>
				</div>
			</div>

			<!-- Handle Duplicates -->
			<div class="p-4 rounded-lg bg-bg-surface">
				<h4 class="text-sm font-medium text-text-primary mb-3">
					{{ t('components.contacts.csvImportModal.mapping.handleDuplicates') }}
				</h4>
				<div class="flex gap-4">
					<label class="flex items-center gap-2 cursor-pointer">
						<input
							v-model="csvImport.handleDuplicates.value"
							type="radio"
							value="skip"
							class="w-4 h-4 text-brand"
						/>
						<span class="text-sm text-text-secondary">{{
							t('components.contacts.csvImportModal.mapping.skipDuplicates')
						}}</span>
					</label>
					<label class="flex items-center gap-2 cursor-pointer">
						<input
							v-model="csvImport.handleDuplicates.value"
							type="radio"
							value="update"
							class="w-4 h-4 text-brand"
						/>
						<span class="text-sm text-text-secondary">{{
							t('components.contacts.csvImportModal.mapping.updateExisting')
						}}</span>
					</label>
				</div>
			</div>

			<!-- Add to Topic -->
			<div v-if="availableLists.length > 0" class="mt-4 p-4 rounded-lg bg-bg-surface">
				<h4 class="text-sm font-medium text-text-primary mb-3">
					{{ t('components.contacts.csvImportModal.mapping.addToTopic') }}
				</h4>
				<select
					:value="csvImport.selectedTopicId.value ?? ''"
					class="input w-full"
					:disabled="csvImport.isTopicMapped.value"
					@change="
						csvImport.selectGlobalTopic(($event.target as HTMLSelectElement).value || null)
					"
				>
					<option value="">{{ t('common.none') }}</option>
					<option v-for="list in availableLists" :key="list._id" :value="list._id">
						{{ list.name }}
					</option>
				</select>
				<p v-if="csvImport.isTopicMapped.value" class="text-xs text-text-tertiary mt-2">
					{{ t('components.contacts.csvImportModal.mapping.topicMappedHint') }}
				</p>
				<p v-else class="text-xs text-text-tertiary mt-2">
					{{ t('components.contacts.csvImportModal.mapping.globalTopicHint') }}
				</p>
			</div>
		</div>

		<!-- Step 2.5: List Mapping -->
		<div v-else-if="csvImport.step.value === 'listMapping'">
			<div class="mb-4">
				<I18nT
					keypath="components.contacts.csvImportModal.listMapping.found"
					tag="p"
					class="text-sm text-text-secondary"
					scope="global"
					:plural="csvImport.detectedListNames.value.length"
				>
					<template #count>
						<span class="text-text-primary font-medium">{{
							csvImport.detectedListNames.value.length
						}}</span>
					</template>
				</I18nT>
			</div>
			<div class="space-y-3">
				<div
					v-for="name in csvImport.detectedListNames.value"
					:key="name"
					class="flex items-center gap-4 p-3 rounded-lg bg-bg-surface"
				>
					<div class="flex-1 min-w-0">
						<p class="text-sm font-medium text-text-primary truncate">{{ name }}</p>
					</div>
					<select
						:value="csvImport.listNameMapping.value[name] ?? ''"
						class="input w-56 shrink-0"
						@change="
							csvImport.listNameMapping.value[name] =
								($event.target as HTMLSelectElement).value || null
						"
					>
						<option value="">
							{{ t('components.contacts.csvImportModal.listMapping.skip') }}
						</option>
						<option v-for="list in availableLists" :key="list._id" :value="list._id">
							{{ list.name }}
						</option>
					</select>
				</div>
			</div>
			<div
				v-if="csvImport.detectedListNames.value.length === 0"
				class="p-4 rounded-lg bg-warning-subtle border border-warning/20"
			>
				<p class="text-sm text-warning">
					{{ t('components.contacts.csvImportModal.listMapping.noneFound') }}
				</p>
			</div>
		</div>

		<!-- Step 3: Preview -->
		<div v-else-if="csvImport.step.value === 'preview'">
			<!-- Validation Summary Cards -->
			<div v-if="validationResult" class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
				<div class="p-3 rounded-lg bg-success/10 border border-success/20">
					<p class="text-2xl font-medium tracking-[-0.02em] text-success">{{ validationResult.validCount }}</p>
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
						:class="
							validationResult.invalidEmails.length > 0 ? 'text-warning' : 'text-text-tertiary'
						"
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
							validationResult.duplicateEmails.length > 0
								? 'text-warning/80'
								: 'text-text-tertiary'
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
						:class="
							validationResult.missingEmails.length > 0 ? 'text-error' : 'text-text-tertiary'
						"
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
							v-for="(row, index) in csvImport.previewRows.value"
							:key="index"
							class="border-b border-border-subtle last:border-b-0"
						>
							<td class="px-4 py-2">
								<Icon
									v-if="getRowValidationStatus(index + 1) === 'valid'"
									name="lucide:check-circle"
									class="w-4 h-4 text-success"
								/>
								<Icon
									v-else-if="getRowValidationStatus(index + 1) === 'warning'"
									name="lucide:alert-triangle"
									class="w-4 h-4 text-warning"
								/>
								<Icon v-else name="lucide:x-circle" class="w-4 h-4 text-error" />
							</td>
							<td class="px-4 py-2 text-text-primary">
								{{ csvImport.getMappedValue(row, 'email') }}
							</td>
							<td class="px-4 py-2 text-text-secondary">
								{{ csvImport.getMappedValue(row, 'firstName') }}
							</td>
							<td class="px-4 py-2 text-text-secondary">
								{{ csvImport.getMappedValue(row, 'lastName') }}
							</td>
						</tr>
					</tbody>
				</table>
			</div>

			<!-- Expandable Error Details -->
			<div v-if="csvImport.hasValidationWarnings.value" class="mt-4">
				<button
					class="flex items-center gap-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
					@click="showValidationDetails = !showValidationDetails"
				>
					<Icon
						name="lucide:chevron-right"
						class="w-4 h-4 transition-transform"
						:class="{ 'rotate-90': showValidationDetails }"
					/>
					{{ t('components.contacts.csvImportModal.preview.viewIssues') }}
				</button>
				<div v-if="showValidationDetails && validationResult" class="mt-2 space-y-3">
					<div
						v-if="validationResult.invalidEmails.length > 0"
						class="p-3 rounded-lg bg-warning/5 border border-warning/20"
					>
						<h5 class="text-sm font-medium text-warning mb-1">
							{{ t('components.contacts.csvImportModal.preview.invalidEmailsTitle') }}
						</h5>
						<ul class="text-xs text-text-secondary space-y-0.5">
							<I18nT
								v-for="entry in validationResult.invalidEmails.slice(0, 10)"
								:key="entry.row"
								keypath="components.contacts.csvImportModal.preview.rowEntry"
								tag="li"
								scope="global"
							>
								<template #row>{{ entry.row }}</template>
								<template #value>
									<span class="text-text-primary">{{ entry.email }}</span>
								</template>
							</I18nT>
							<li v-if="validationResult.invalidEmails.length > 10" class="text-text-tertiary">
								{{
									t('components.contacts.csvImportModal.preview.andMore', {
										count: validationResult.invalidEmails.length - 10,
									})
								}}
							</li>
						</ul>
					</div>
					<div
						v-if="validationResult.duplicateEmails.length > 0"
						class="p-3 rounded-lg bg-warning/5 border border-warning/20"
					>
						<h5 class="text-sm font-medium text-warning mb-1">
							{{ t('components.contacts.csvImportModal.preview.duplicateEmailsTitle') }}
						</h5>
						<ul class="text-xs text-text-secondary space-y-0.5">
							<I18nT
								v-for="entry in validationResult.duplicateEmails.slice(0, 10)"
								:key="entry.row"
								keypath="components.contacts.csvImportModal.preview.rowEntry"
								tag="li"
								scope="global"
							>
								<template #row>{{ entry.row }}</template>
								<template #value>
									<span class="text-text-primary">{{ entry.email }}</span>
								</template>
							</I18nT>
							<li v-if="validationResult.duplicateEmails.length > 10" class="text-text-tertiary">
								{{
									t('components.contacts.csvImportModal.preview.andMore', {
										count: validationResult.duplicateEmails.length - 10,
									})
								}}
							</li>
						</ul>
					</div>
					<div
						v-if="validationResult.missingEmails.length > 0"
						class="p-3 rounded-lg bg-error-subtle border border-error/20"
					>
						<h5 class="text-sm font-medium text-error mb-1">
							{{ t('components.contacts.csvImportModal.preview.missingEmailsTitle') }}
						</h5>
						<ul class="text-xs text-text-secondary space-y-0.5">
							<I18nT
								v-for="rowNum in validationResult.missingEmails.slice(0, 10)"
								:key="rowNum"
								keypath="components.contacts.csvImportModal.preview.rowEntry"
								tag="li"
								scope="global"
							>
								<template #row>{{ rowNum }}</template>
								<template #value>
									<span class="text-text-tertiary">{{
										t('components.contacts.csvImportModal.emptyCell')
									}}</span>
								</template>
							</I18nT>
							<li v-if="validationResult.missingEmails.length > 10" class="text-text-tertiary">
								{{
									t('components.contacts.csvImportModal.preview.andMore', {
										count: validationResult.missingEmails.length - 10,
									})
								}}
							</li>
						</ul>
					</div>
				</div>
			</div>

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
								mappedPropertyKeys.length,
							)
						}}
					</li>
				</ul>
			</div>
		</div>

		<!-- Step 4: Importing -->
		<div v-else-if="csvImport.step.value === 'importing'" class="py-8">
			<div class="flex flex-col items-center gap-6">
				<div class="relative">
					<div class="w-20 h-20 rounded-full border-4 border-bg-surface" />
					<div
						class="absolute inset-0 w-20 h-20 rounded-full border-4 border-brand border-t-transparent animate-spin motion-reduce:animate-none"
					/>
				</div>
				<div class="text-center">
					<p class="text-lg font-medium text-text-primary">
						{{ t('components.contacts.csvImportModal.importing.title') }}
					</p>
					<p class="text-sm text-text-tertiary mt-1">
						{{
							t('components.contacts.csvImportModal.importing.percent', {
								percent: csvImport.progress.value,
							})
						}}
					</p>
				</div>
				<UiProgressBar
					class="max-w-xs"
					size="sm"
					:value="csvImport.progress.value"
					:aria-label="t('components.contacts.csvImportModal.importing.progressLabel')"
				/>
			</div>
		</div>

		<!-- Step 5: Complete -->
		<div v-else-if="csvImport.step.value === 'complete'" class="py-4">
			<div class="flex flex-col items-center gap-4 mb-6">
				<div class="p-3 rounded-full bg-success/10">
					<Icon name="lucide:check" class="w-8 h-8 text-success" />
				</div>
				<p class="text-lg font-medium text-text-primary">
					{{ t('components.contacts.csvImportModal.complete.title') }}
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
					:value="csvImport.results.value?.failed || 0"
					:label="t('components.contacts.csvImportModal.complete.failed')"
					variant="error"
				/>
			</div>
			<div
				v-if="csvImport.results.value?.addedToList && csvImport.results.value.addedToList > 0"
				class="mb-4 p-3 rounded-lg bg-brand/5 border border-brand/20 flex items-center gap-3"
			>
				<Icon name="lucide:list" class="w-5 h-5 text-brand shrink-0" />
				<p class="text-sm text-text-secondary">
					{{
						t(
							'components.contacts.csvImportModal.complete.addedToTopics',
							{ count: csvImport.results.value.addedToList },
							csvImport.results.value.addedToList,
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
					<UiButton
						:disabled="!addToTopicId"
						:loading="isAddingToTopic"
						@click="confirmAddToTopic()"
					>
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

		<!-- Footer -->
		<template #footer>
			<template v-if="isConfirmingDiscard">
				<UiButton variant="secondary" @click="cancelDiscard()">{{
					t('components.contacts.csvImportModal.discard.keepEditing')
				}}</UiButton>
				<UiButton variant="danger" @click="confirmDiscard()">{{ t('common.discard') }}</UiButton>
			</template>
			<template v-else-if="csvImport.step.value === 'upload'">
				<UiButton variant="secondary" @click="requestClose()">{{ t('common.cancel') }}</UiButton>
			</template>
			<template v-else-if="csvImport.step.value === 'mapping'">
				<UiButton variant="secondary" @click="csvImport.step.value = 'upload'">{{
					t('common.back')
				}}</UiButton>
				<UiButton :disabled="!csvImport.isEmailMapped.value" @click="csvImport.goToPreview()">{{
					t('common.continue')
				}}</UiButton>
			</template>
			<template v-else-if="csvImport.step.value === 'listMapping'">
				<UiButton variant="secondary" @click="csvImport.goBackToMappingFromListMapping()">{{
					t('common.back')
				}}</UiButton>
				<UiButton @click="csvImport.goToPreviewFromListMapping()">{{
					t('common.continue')
				}}</UiButton>
			</template>
			<template v-else-if="csvImport.step.value === 'preview'">
				<UiButton variant="secondary" @click="csvImport.goBackToMapping()">{{
					t('common.back')
				}}</UiButton>
				<UiButton :disabled="!csvImport.canImport.value" @click="emit('import')">
					<template #iconLeft><Icon name="lucide:upload" class="w-4 h-4" /></template>
					{{
						t('components.contacts.csvImportModal.footer.import', {
							count: csvImport.validContactCount.value,
						})
					}}
				</UiButton>
			</template>
			<template v-else-if="csvImport.step.value === 'complete'">
				<UiButton v-if="errorRows.length > 0" variant="secondary" @click="downloadErrorRows()">
					<template #iconLeft><Icon name="lucide:download" class="w-4 h-4" /></template>
					{{ t('components.contacts.csvImportModal.complete.downloadErrors') }}
				</UiButton>
				<UiButton
					v-if="availableLists.length > 0"
					variant="secondary"
					@click="isAddToTopicOpen = !isAddToTopicOpen"
				>
					<template #iconLeft><Icon name="lucide:tag" class="w-4 h-4" /></template>
					{{ t('components.contacts.csvImportModal.complete.addToTopic') }}
				</UiButton>
				<UiButton @click="viewImported()">
					{{ t('components.contacts.csvImportModal.complete.viewImported') }}
					<template #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4" /></template>
				</UiButton>
			</template>
		</template>
	</UiModal>
</template>
