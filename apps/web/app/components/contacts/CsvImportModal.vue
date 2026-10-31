<script setup lang="ts">
import type { ImportStep } from '~/composables/useCsvImport';
import { useCsvImportCompletion } from '~/composables/csvImport/useCsvImportCompletion';
import CsvImportCompleteStep from './csvImport/CompleteStep.vue';
import CsvImportListMappingStep from './csvImport/ListMappingStep.vue';
import CsvImportMappingStep from './csvImport/MappingStep.vue';
import CsvImportPreviewStep from './csvImport/PreviewStep.vue';
import CsvImportUploadStep from './csvImport/UploadStep.vue';

const props = defineProps<{
	csvImport: ReturnType<typeof useCsvImport>;
	topics?: Array<{ _id: string; name: string }>;
}>();

const emit = defineEmits<{
	import: [];
	/** Resend the rows a failed batch left behind (`csvImport.retryFailedRows`). */
	retry: [];
}>();

const { t } = useI18n();

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
			return props.csvImport.notImportedRowCount.value > 0
				? t('components.contacts.csvImportModal.complete.incompleteTitle')
				: t('components.contacts.csvImportModal.steps.complete');
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
 * `upload` has nothing to lose, so it closes straight away, and so does a
 * `complete` step that took every row. An INCOMPLETE one asks too: its retry set
 * lives only in the composable, so closing it drops the one way to send the rows
 * a failed batch left behind. `importing` is blocked by `canClose` and never
 * reaches here.
 */
const DISCARDABLE_STEPS: ReadonlySet<ImportStep> = new Set(['mapping', 'listMapping', 'preview']);

const holdsUnsavedWork = () =>
	DISCARDABLE_STEPS.has(props.csvImport.step.value) ||
	(props.csvImport.step.value === 'complete' && props.csvImport.notImportedRowCount.value > 0);

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
	if (holdsUnsavedWork()) {
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

// The preview's issue panel and the mapping step's live region keep their
// state here, so leaving a step and coming back finds them as they were.
const showValidationDetails = ref(false);

/** Read out when a pick moves a field off another column, which changes that select too. */
const mappingAnnouncement = ref('');

const availableLists = computed(() => props.topics ?? []);

// Find list name by ID for display
const getListName = (listId: string): string => {
	return (
		availableLists.value.find((l) => l._id === listId)?.name ??
		t('components.contacts.csvImportModal.unknownList')
	);
};

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
			mapped
		);
	}
	return null;
});

const completion = useCsvImportCompletion(props.csvImport, getListName);
const {
	downloadableErrorRows,
	downloadErrorRows,
	isAddToTopicOpen,
	isIncomplete,
	notImportedCount,
	viewImported,
} = completion;

// The composable resets its own state on `open()`; this is the modal's share of
// it, so an armed discard prompt or a finished import's follow-ups never greet
// the next one.
watch(
	() => props.csvImport.isOpen.value,
	(open) => {
		if (!open) return;
		isConfirmingDiscard.value = false;
		completion.reset();
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
			role="alert"
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
					{{
						csvImport.step.value === 'complete'
							? t(
									'components.contacts.csvImportModal.discard.incompleteBody',
									{ count: csvImport.notImportedRowCount.value },
									csvImport.notImportedRowCount.value
								)
							: t('components.contacts.csvImportModal.discard.body')
					}}
				</p>
			</div>
		</div>

		<!-- Step 1: Upload -->
		<CsvImportUploadStep v-else-if="csvImport.step.value === 'upload'" :csv-import="csvImport" />

		<!-- Step 2: Mapping -->
		<CsvImportMappingStep
			v-else-if="csvImport.step.value === 'mapping'"
			v-model:announcement="mappingAnnouncement"
			:csv-import="csvImport"
			:available-lists="availableLists"
		/>

		<!-- Step 2.5: List Mapping -->
		<CsvImportListMappingStep
			v-else-if="csvImport.step.value === 'listMapping'"
			:csv-import="csvImport"
			:available-lists="availableLists"
		/>

		<!-- Step 3: Preview -->
		<CsvImportPreviewStep
			v-else-if="csvImport.step.value === 'preview'"
			v-model:show-details="showValidationDetails"
			:csv-import="csvImport"
			:topic-assignment-summary="topicAssignmentSummary"
		/>

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
		<CsvImportCompleteStep
			v-else-if="csvImport.step.value === 'complete'"
			:csv-import="csvImport"
			:completion="completion"
			:available-lists="availableLists"
		/>

		<!-- Footer -->
		<template #footer>
			<!-- Footers with more than two actions: secondary actions on the left,
				 the decision on the right. Labels stay on one line; when the row does
				 not fit, the right-hand group wraps below as a whole. -->
			<div
				v-if="isConfirmingDiscard"
				class="flex w-full flex-wrap items-center justify-between gap-3"
			>
				<div class="flex flex-wrap gap-3">
					<!-- The prompt tells the operator to download the missing rows first,
						 so the download is offered right here. -->
					<UiButton
						v-if="csvImport.step.value === 'complete' && downloadableErrorRows.length > 0"
						variant="secondary"
						class="whitespace-nowrap"
						@click="downloadErrorRows()"
					>
						<template #iconLeft><Icon name="lucide:download" class="w-4 h-4" /></template>
						{{ t('components.contacts.csvImportModal.complete.downloadErrors') }}
					</UiButton>
				</div>
				<div class="ml-auto flex flex-wrap justify-end gap-3">
					<UiButton variant="secondary" class="whitespace-nowrap" @click="cancelDiscard()">{{
						t('components.contacts.csvImportModal.discard.keepEditing')
					}}</UiButton>
					<UiButton variant="danger" class="whitespace-nowrap" @click="confirmDiscard()">{{
						t('common.discard')
					}}</UiButton>
				</div>
			</div>
			<template v-else-if="csvImport.step.value === 'upload'">
				<UiButton variant="secondary" @click="requestClose()">{{ t('common.cancel') }}</UiButton>
			</template>
			<template v-else-if="csvImport.step.value === 'mapping'">
				<UiButton variant="secondary" @click="csvImport.step.value = 'upload'">{{
					t('common.back')
				}}</UiButton>
				<UiButton
					:disabled="!csvImport.isEmailMapped.value || csvImport.mappingConflict.value !== null"
					@click="csvImport.goToPreview()"
					>{{ t('common.continue') }}</UiButton
				>
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
			<div
				v-else-if="csvImport.step.value === 'complete'"
				class="flex w-full flex-wrap items-center justify-between gap-3"
			>
				<div class="flex flex-wrap gap-3">
					<UiButton
						v-if="downloadableErrorRows.length > 0"
						variant="secondary"
						class="whitespace-nowrap"
						@click="downloadErrorRows()"
					>
						<template #iconLeft><Icon name="lucide:download" class="w-4 h-4" /></template>
						{{ t('components.contacts.csvImportModal.complete.downloadErrors') }}
					</UiButton>
					<UiButton
						v-if="availableLists.length > 0"
						variant="secondary"
						class="whitespace-nowrap"
						@click="isAddToTopicOpen = !isAddToTopicOpen"
					>
						<template #iconLeft><Icon name="lucide:tag" class="w-4 h-4" /></template>
						{{ t('components.contacts.csvImportModal.complete.addToTopic') }}
					</UiButton>
				</div>
				<div class="ml-auto flex flex-wrap justify-end gap-3">
					<UiButton
						:variant="isIncomplete ? 'secondary' : 'primary'"
						class="whitespace-nowrap"
						@click="viewImported()"
					>
						{{ t('components.contacts.csvImportModal.complete.viewImported') }}
						<template #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4" /></template>
					</UiButton>
					<UiButton v-if="isIncomplete" class="whitespace-nowrap" @click="emit('retry')">
						<template #iconLeft><Icon name="lucide:rotate-cw" class="w-4 h-4" /></template>
						{{
							t(
								'components.contacts.csvImportModal.complete.retry',
								{ count: notImportedCount },
								notImportedCount
							)
						}}
					</UiButton>
				</div>
			</div>
		</template>
	</UiModal>
</template>
