<script setup lang="ts">
import { parseStoredBlocks } from '@owlat/email-builder/stored-blocks';
import { api } from '@owlat/api';
import { languageOptions } from '~/data/languageOptions';
import { translationBlockRows, type TranslatableRow } from '~/utils/translationRows';
import { budgetCopyKeyOfError } from '~/utils/aiBudget';
import {
	buildLanguageAdd,
	buildTranslationUpdate,
	translationBaseOf,
	type TranslationBase,
	type TranslationField,
	type TranslationFieldEdit,
} from '~/composables/translationSave';
import {
	useTranslationDrafts,
	type TranslationCell,
	type TranslationCommitResult,
} from '~/composables/useTranslationDrafts';
import {
	useTranslationEmail,
	type TranslationEmailType,
} from '~/composables/translation/useTranslationEmail';
import TranslationTable from './Table.vue';

type EmailType = TranslationEmailType;

interface Props {
	emailId: string;
	emailType: EmailType;
}

const props = defineProps<Props>();
const emit = defineEmits<{
	back: [];
}>();

const { t } = useI18n();
const router = useRouter();
const { showToast } = useToast();
const { emailTheme } = useEmailTheme();

const {
	email,
	isLoading,
	emailError,
	refetchEmail,
	updateTranslation,
	addTranslation,
	removeTranslation,
} = useTranslationEmail(props);

// State
const isSaving = ref(false);
const isTranslating = ref<string | null>(null); // Language code being translated

const defaultLanguage = computed(() => email.value?.defaultLanguage || 'en');
const supportedLanguages = computed(
	() => email.value?.supportedLanguages || [defaultLanguage.value]
);

// The server row every write is built on. Clean cells always show it; edited
// cells show their own draft until their write lands (useTranslationDrafts).
const translationBase = computed<TranslationBase | null>(() =>
	email.value ? translationBaseOf(email.value) : null
);

const renderOptions = () => ({
	theme: emailTheme.value,
	variableType: props.emailType === 'marketing' ? ('personalization' as const) : ('data' as const),
});

// One write per save: the language's overlay and the HTML rendered from it,
// named by the revision of the row they were built on.
const commitTranslation = async (
	base: TranslationBase,
	language: string,
	edits: readonly TranslationFieldEdit[]
): Promise<TranslationCommitResult> =>
	updateTranslation(buildTranslationUpdate(base, language, edits, renderOptions()));

const {
	valueOf,
	statusOf,
	saveCell,
	save: saveCells,
	retry: retryCell,
	discard: discardCell,
	forgetLanguage,
	setOpenEdit,
	runWrite,
	saveAll,
	failedCount,
	isSaving: isSavingCells,
	hasUnsavedWork,
} = useTranslationDrafts({ base: translationBase, commit: commitTranslation });

// Leaving with a cell still being typed in, saving or not saved asks first.
const {
	showDialog: showUnsavedDialog,
	isSavingBeforeLeave,
	confirmDiscard,
	confirmSave,
	cancelNavigation,
	setHasChanges,
} = useUnsavedChanges({
	onSave: async () => {
		if (!(await saveAll())) throw new Error('Translations not saved');
	},
});
watch(hasUnsavedWork, setHasChanges, { immediate: true });

// Computed: non-default languages (columns to show)
const translationLanguages = computed(() => {
	return supportedLanguages.value.filter((lang) => lang !== defaultLanguage.value);
});

// Computed: available languages to add
const availableLanguages = computed(() => {
	return languageOptions.filter((lang) => !supportedLanguages.value.includes(lang.value));
});

// Get language info
const getLanguageInfo = (code: string) => {
	return languageOptions.find((l) => l.value === code) || { label: code, nativeLabel: code };
};

// The catalog carries message keys for the localized names; the endonym is the
// same in every locale, so an unknown one falls through as its own text.
const languageLabel = (code: string) => t(getLanguageInfo(code).label);
const languageNativeLabel = (code: string) => t(getLanguageInfo(code).nativeLabel);

// Extract translatable rows from email content
const translatableRows = computed((): TranslatableRow[] => {
	if (!email.value) return [];

	const rows: TranslatableRow[] = [];

	// Subject line
	rows.push({
		id: '_subject',
		fieldType: 'subject',
		sourceText: email.value.subject || '',
		label: t('components.translation.manager.subjectLine'),
	});

	// Preview text (marketing only)
	if (props.emailType === 'marketing' && 'previewText' in email.value && email.value.previewText) {
		rows.push({
			id: '_previewText',
			fieldType: 'previewText',
			sourceText: email.value.previewText,
			label: t('components.translation.manager.previewText'),
		});
	}

	// Content blocks, at every depth; unreadable content contributes no rows.
	rows.push(...translationBlockRows(parseStoredBlocks(email.value.content), t));

	return rows;
});

// The overlay value a row edits.
const fieldOf = (row: TranslatableRow): TranslationField => {
	if (row.fieldType === 'subject') return { kind: 'subject' };
	if (row.fieldType === 'previewText') return { kind: 'previewText' };
	return { kind: 'block', blockId: row.blockId ?? row.id, property: row.fieldType };
};

const cellOf = (row: TranslatableRow, language: string): TranslationCell => ({
	language,
	rowId: row.id,
	field: fieldOf(row),
});

// Get translation value for a row and language
const getTranslationValue = (row: TranslatableRow, language: string): string => {
	if (language === defaultLanguage.value) {
		return row.sourceText;
	}
	return valueOf(cellOf(row, language));
};

// Add a new language
const addLanguage = async (langCode: string) => {
	isSaving.value = true;
	try {
		// The overlay the backend seeds and its HTML land in the same write.
		const added = await runWrite((base) =>
			addTranslation({ language: langCode, ...buildLanguageAdd(base, renderOptions()) })
		);
		if (!added.ok) return;
		showToast(
			t('components.translation.manager.languageAdded', { language: languageLabel(langCode) })
		);
	} finally {
		isSaving.value = false;
	}
};

// Remove a language — open a themed confirmation first.
const languageToRemove = ref<string | null>(null);

const removeLanguage = (langCode: string) => {
	languageToRemove.value = langCode;
};

const confirmRemoveLanguage = async () => {
	const langCode = languageToRemove.value;
	if (!langCode) return;

	isSaving.value = true;
	try {
		const removed = await runWrite((base) =>
			removeTranslation({ language: langCode, expectedContentRevision: base.revision })
		);
		if (!removed.ok) return;
		forgetLanguage(langCode);
		showToast(
			t('components.translation.manager.languageRemoved', { language: languageLabel(langCode) })
		);
	} finally {
		isSaving.value = false;
		languageToRemove.value = null;
	}
};

// Auto-translate a column using AI
const autoTranslateColumn = async (targetLanguage: string) => {
	isTranslating.value = targetLanguage;

	try {
		// Collect items to translate
		const itemsToTranslate = translatableRows.value
			.filter((row) => row.sourceText && !getTranslationValue(row, targetLanguage))
			.map((row) => ({
				id: row.id,
				text: row.sourceText,
				isHtml: row.fieldType === 'html',
			}));

		if (itemsToTranslate.length === 0) {
			showToast(t('components.translation.manager.allTranslated'));
			return;
		}

		// Call AI translation action via Convex
		const result = await requireConvex().action(api.emailTemplates.translate.translateBatch, {
			items: itemsToTranslate,
			sourceLanguage: languageLabel(defaultLanguage.value),
			targetLanguage: languageLabel(targetLanguage),
		});

		// Apply the translations as one write. A failed write keeps every
		// generated value as a draft in its cell, to retry or discard.
		const entries = result.translations.flatMap((item) => {
			const row = translatableRows.value.find((r) => r.id === item.id);
			return row ? [{ cell: cellOf(row, targetLanguage), value: item.translatedText }] : [];
		});
		if (!(await saveCells(targetLanguage, entries))) return;

		showToast(
			t('components.translation.manager.autoTranslated', {
				count: result.translations.length,
				language: languageLabel(targetLanguage),
			})
		);
	} catch (error) {
		// U5: a budget refusal says which budget, not that translating failed.
		const budgetKey = budgetCopyKeyOfError(error);
		showToast(
			budgetKey ? t(budgetKey) : t('components.translation.manager.autoTranslateFailed'),
			'error'
		);
	} finally {
		isTranslating.value = null;
	}
};

// Navigation
const handleBack = () => {
	if (props.emailType === 'marketing') {
		router.push(`/dashboard/send/emails/${props.emailId}/edit`);
	} else {
		router.push(`/dashboard/send/transactional/${props.emailId}/edit`);
	}
};
</script>

<template>
	<div class="h-[calc(100vh-64px)] flex flex-col bg-bg-base">
		<!-- Header -->
		<div
			class="shrink-0 h-14 border-b border-border-subtle bg-bg-elevated flex items-center justify-between px-4"
		>
			<div class="flex items-center gap-4">
				<button
					class="p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					@click="handleBack"
					:aria-label="t('common.back')"
				>
					<Icon name="lucide:arrow-left" class="w-5 h-5" />
				</button>

				<div class="flex items-center gap-2">
					<Icon name="lucide:globe" class="w-5 h-5 text-text-tertiary" />
					<span class="text-text-primary font-medium">
						{{
							t('components.translation.manager.heading', {
								name: email?.name || t('components.translation.manager.emailFallbackName'),
							})
						}}
					</span>
				</div>
			</div>

			<div class="flex items-center gap-3">
				<span v-if="failedCount > 0" class="text-sm text-warning flex items-center gap-1.5">
					<Icon name="lucide:alert-circle" class="w-4 h-4" />
					{{ t('components.translation.manager.unsavedChanges') }}
				</span>
				<span
					v-else-if="isSavingCells"
					class="text-sm text-text-secondary flex items-center gap-1.5"
				>
					<UiSpinner size="xs" />
					{{ t('components.translation.manager.savingChanges') }}
				</span>
			</div>
		</div>

		<div v-if="emailError" class="flex-1 flex items-center justify-center">
			<UiQueryBoundary :error="emailError" @retry="refetchEmail" />
		</div>

		<!-- Loading State -->
		<div v-else-if="isLoading" class="flex-1 flex items-center justify-center">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">
					{{ t('components.translation.manager.loadingEmail') }}
				</p>
			</div>
		</div>

		<!-- Not Found State -->
		<div v-else-if="!email" class="flex-1 flex items-center justify-center">
			<div class="text-center">
				<div class="w-12 h-12 text-error mx-auto mb-4">!</div>
				<h2 class="text-xl font-semibold text-text-primary mb-2">
					{{ t('components.translation.manager.notFoundTitle') }}
				</h2>
				<p class="text-text-secondary mb-6">
					{{ t('components.translation.manager.notFoundDescription') }}
				</p>
				<UiButton @click="handleBack">{{ t('components.translation.manager.goBack') }}</UiButton>
			</div>
		</div>

		<!-- Translation Table -->
		<div v-else class="flex-1 overflow-auto p-6">
			<div class="max-w-[1400px] mx-auto">
				<!-- Empty state when no rows -->
				<div
					v-if="translatableRows.length === 0"
					class="text-center py-16 border border-dashed border-border-subtle rounded-xl"
				>
					<Icon name="lucide:globe" class="w-10 h-10 text-text-tertiary mx-auto mb-4" />
					<h3 class="text-lg font-medium text-text-primary mb-2">
						{{ t('components.translation.manager.emptyTitle') }}
					</h3>
					<p class="text-text-secondary">
						{{ t('components.translation.manager.emptyDescription') }}
					</p>
				</div>

				<!-- Translation Table -->
				<TranslationTable
					v-else
					:rows="translatableRows"
					:default-language="defaultLanguage"
					:languages="translationLanguages"
					:available-languages="availableLanguages"
					:translating-language="isTranslating"
					:is-saving="isSaving"
					:native-label-of="languageNativeLabel"
					:cell-value="getTranslationValue"
					:cell-status="(row, lang) => statusOf(cellOf(row, lang))"
					@auto-translate="autoTranslateColumn"
					@remove-language="removeLanguage"
					@add-language="addLanguage"
					@save="(row, lang, value) => saveCell(cellOf(row, lang), value)"
					@retry="(row, lang) => retryCell(cellOf(row, lang))"
					@discard="(row, lang) => discardCell(cellOf(row, lang))"
					@edit="(row, lang, text) => setOpenEdit(cellOf(row, lang), text)"
				/>

				<!-- Info Card -->
				<div class="mt-6 p-4 rounded-xl surface-3">
					<div class="flex gap-3">
						<Icon name="lucide:globe" class="w-5 h-5 text-brand shrink-0 mt-0.5" />
						<div class="text-sm">
							<p class="text-text-primary font-medium mb-1">
								{{ t('components.translation.manager.infoTitle') }}
							</p>
							<p class="text-text-secondary">
								{{ t('components.translation.manager.infoBody') }}
							</p>
						</div>
					</div>
				</div>
			</div>
			<UiConfirmationDialog
				:open="!!languageToRemove"
				variant="danger"
				:title="t('components.translation.manager.removeConfirmTitle')"
				:description="
					languageToRemove
						? t('components.translation.manager.removeConfirmDescription', {
								language: languageLabel(languageToRemove),
							})
						: t('components.translation.manager.removeConfirmFallback')
				"
				:confirm-text="t('components.translation.manager.removeConfirmAction')"
				:is-loading="isSaving"
				@update:open="(v: boolean) => !v && (languageToRemove = null)"
				@confirm="confirmRemoveLanguage"
			/>
		</div>

		<UiUnsavedChangesDialog
			:show="showUnsavedDialog"
			:saving="isSavingBeforeLeave"
			@close="cancelNavigation"
			@discard="confirmDiscard"
			@save="confirmSave"
		/>
	</div>
</template>
