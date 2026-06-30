<script setup lang="ts">
import { api } from '@owlat/api';
import { languageOptions } from '~/data/languageOptions';
import type { Id } from '@owlat/api/dataModel';

type EmailType = 'marketing' | 'transactional';

interface Props {
	emailId: string;
	emailType: EmailType;
}

const props = defineProps<Props>();
const emit = defineEmits<{
	back: [];
}>();

const router = useRouter();
const { showToast } = useToast();
const { emailTheme } = useEmailTheme();
const { renderContentToHtml, loadLanguageContentForEmail } = useEmailHtmlRendering();

// Type definitions
interface TranslatableBlockContent {
	html?: string;
	buttonText?: string;
	alt?: string;
}

interface Translation {
	subject: string;
	previewText?: string;
	blocks: Record<string, TranslatableBlockContent>;
}

interface TranslatableRow {
	id: string;
	fieldType: 'subject' | 'previewText' | 'html' | 'buttonText' | 'alt';
	sourceText: string;
	label: string;
	blockId?: string;
}

interface Block {
	id: string;
	type: string;
	content: {
		html?: string;
		text?: string;
		alt?: string;
		columns?: Array<Array<{ id: string; type: string; content: Record<string, unknown> }>>;
		items?: Array<{ id: string; type: string; content: Record<string, unknown> }>;
		[key: string]: unknown;
	};
}

// Common languages for dropdown

// Fetch email data based on type
const { data: marketingEmail, isLoading: marketingLoading } = useConvexQuery(
	api.emailTemplates.emails.get,
	() => {
		if (props.emailType !== 'marketing') return 'skip';
		return { templateId: props.emailId as Id<'emailTemplates'> };
	}
);

const { data: transactionalEmail, isLoading: transactionalLoading } = useConvexQuery(
	api.transactional.emails.get,
	() => {
		if (props.emailType !== 'transactional') return 'skip';
		return { id: props.emailId as Id<'transactionalEmails'> };
	}
);

// Unified email object
const email = computed(() => {
	if (props.emailType === 'marketing') return marketingEmail.value;
	return transactionalEmail.value;
});

const isLoading = computed(() => {
	if (props.emailType === 'marketing') return marketingLoading.value;
	return transactionalLoading.value;
});

// Mutations
const { run: updateMarketingTemplate } = useBackendOperation(api.emailTemplates.emails.update, {
	label: 'Save translations',
});
const { run: addMarketingTranslation } = useBackendOperation(
	api.emailTemplates.i18n.addTranslation,
	{ label: 'Add language' }
);
const { run: updateMarketingTranslation } = useBackendOperation(
	api.emailTemplates.i18n.updateTranslation,
	{ label: 'Save translation' }
);
const { run: removeMarketingTranslation } = useBackendOperation(
	api.emailTemplates.i18n.removeTranslation,
	{ label: 'Remove language' }
);

const { run: updateTransactionalEmail } = useBackendOperation(api.transactional.emails.update, {
	label: 'Save translations',
});
const { run: addTransactionalTranslation } = useBackendOperation(
	api.transactional.translations.addTranslation,
	{ label: 'Add language' }
);
const { run: updateTransactionalTranslation } = useBackendOperation(
	api.transactional.translations.updateTranslation,
	{ label: 'Save translation' }
);
const { run: removeTransactionalTranslation } = useBackendOperation(
	api.transactional.translations.removeTranslation,
	{ label: 'Remove language' }
);

// State
const isSaving = ref(false);
const hasChanges = ref(false);
const savingCells = ref<Set<string>>(new Set());
const isTranslating = ref<string | null>(null); // Language code being translated

// Local translations state (synced from email)
const translations = ref<Record<string, Translation>>({});
const htmlTranslations = ref<Record<string, { htmlContent: string; subject: string }>>({});
const defaultLanguage = ref('en');
const supportedLanguages = ref<string[]>([]);
// emailTheme is provided by useEmailTheme() (declared above).
const emailIdentifier = computed(() =>
	props.emailType === 'marketing'
		? {
				emailType: 'marketing' as const,
				emailId: props.emailId as Id<'emailTemplates'>,
			}
		: {
				emailType: 'transactional' as const,
				emailId: props.emailId as Id<'transactionalEmails'>,
			}
);

// Parse email data when it loads
watch(
	email,
	(e) => {
		if (e) {
			defaultLanguage.value = e.defaultLanguage || 'en';
			supportedLanguages.value = [...(e.supportedLanguages || [defaultLanguage.value])];

			if (e.translations) {
				try {
					translations.value = JSON.parse(e.translations);
				} catch {
					translations.value = {};
				}
			} else {
				translations.value = {};
			}
			if (e.htmlTranslations) {
				try {
					htmlTranslations.value = JSON.parse(e.htmlTranslations);
				} catch {
					htmlTranslations.value = {};
				}
			} else {
				htmlTranslations.value = {};
			}
			hasChanges.value = false;
		}
	},
	{ immediate: true }
);

// Computed: non-default languages (columns to show)
const translationLanguages = computed(() => {
	return supportedLanguages.value.filter((lang) => lang !== defaultLanguage.value);
});

// Computed: available languages to add
const availableLanguages = computed(() => {
	return languageOptions.filter((lang) => !supportedLanguages.value.includes(lang.value));
});

// Dropdown state for add language
const addLanguageDropdownOpen = ref(false);

// Get language info
const getLanguageInfo = (code: string) => {
	return languageOptions.find((l) => l.value === code) || { label: code, nativeLabel: code };
};

const persistHtmlTranslations = async () => {
	const payload = JSON.stringify(htmlTranslations.value);
	if (props.emailType === 'marketing') {
		return await updateMarketingTemplate({
			templateId: props.emailId as Id<'emailTemplates'>,
			htmlTranslations: payload,
		});
	}
	return await updateTransactionalEmail({
		id: props.emailId as Id<'transactionalEmails'>,
		htmlTranslations: payload,
	});
};

const regenerateRenderedLanguage = async (language: string) => {
	const languageContent = await loadLanguageContentForEmail(emailIdentifier.value, language);
	if (!languageContent) return;

	const renderedHtml = await renderContentToHtml(languageContent.content, {
		theme: emailTheme.value,
		variableType: props.emailType === 'marketing' ? 'personalization' : 'data',
	});
	htmlTranslations.value[language] = {
		htmlContent: renderedHtml,
		subject: languageContent.subject,
	};
	await persistHtmlTranslations();
};

// Extract translatable rows from email content
const translatableRows = computed((): TranslatableRow[] => {
	if (!email.value) return [];

	const rows: TranslatableRow[] = [];

	// Subject line
	rows.push({
		id: '_subject',
		fieldType: 'subject',
		sourceText: email.value.subject || '',
		label: 'Subject Line',
	});

	// Preview text (marketing only)
	if (props.emailType === 'marketing' && 'previewText' in email.value && email.value.previewText) {
		rows.push({
			id: '_previewText',
			fieldType: 'previewText',
			sourceText: email.value.previewText,
			label: 'Preview Text',
		});
	}

	// Parse content blocks
	try {
		const blocks = JSON.parse(email.value.content || '[]') as Block[];
		extractBlockRows(blocks, rows);
	} catch {
		// Invalid content
	}

	return rows;
});

// Recursively extract translatable content from blocks
const extractBlockRows = (blocks: Block[], rows: TranslatableRow[], prefix = '') => {
	let textBlockIndex = 0;
	let buttonBlockIndex = 0;
	let imageBlockIndex = 0;
	let containerBlockIndex = 0;

	for (const block of blocks) {
		if (block.type === 'text' && block.content.html) {
			textBlockIndex++;
			rows.push({
				id: block.id,
				blockId: block.id,
				fieldType: 'html',
				sourceText: block.content.html,
				label: `${prefix}Text Block ${textBlockIndex}`,
			});
		} else if (block.type === 'button' && block.content.text) {
			buttonBlockIndex++;
			rows.push({
				id: block.id,
				blockId: block.id,
				fieldType: 'buttonText',
				sourceText: block.content.text,
				label: `${prefix}Button: "${block.content.text}"`,
			});
		} else if (block.type === 'image' && block.content.alt) {
			imageBlockIndex++;
			rows.push({
				id: block.id,
				blockId: block.id,
				fieldType: 'alt',
				sourceText: block.content.alt,
				label: `${prefix}Image ${imageBlockIndex} Alt Text`,
			});
		} else if (block.type === 'columns' && block.content.columns) {
			// Recursively extract from column items
			block.content.columns.forEach((column, colIndex) => {
				extractBlockRows(column as unknown as Block[], rows, `${prefix}Column ${colIndex + 1} > `);
			});
		} else if (block.type === 'container' && block.content.items) {
			// Recursively extract from container items
			containerBlockIndex++;
			extractBlockRows(
				block.content.items as unknown as Block[],
				rows,
				`${prefix}Container ${containerBlockIndex} > `
			);
		}
	}
};

// Get translation value for a row and language
const getTranslationValue = (row: TranslatableRow, language: string): string => {
	if (language === defaultLanguage.value) {
		return row.sourceText;
	}

	const translation = translations.value[language];
	if (!translation) return '';

	if (row.id === '_subject') {
		return translation.subject || '';
	}
	if (row.id === '_previewText') {
		return translation.previewText || '';
	}

	// Block content
	const blockTranslation = translation.blocks?.[row.id];
	if (!blockTranslation) return '';

	switch (row.fieldType) {
		case 'html':
			return blockTranslation.html || '';
		case 'buttonText':
			return blockTranslation.buttonText || '';
		case 'alt':
			return blockTranslation.alt || '';
		default:
			return '';
	}
};

// Update translation value
const updateTranslationValue = async (row: TranslatableRow, language: string, value: string) => {
	const cellKey = `${row.id}:${language}`;
	savingCells.value.add(cellKey);
	// Mark dirty BEFORE persisting: cells auto-save, so the only state the
	// 'Unsaved changes' badge can honestly represent is a local edit whose
	// save has not (yet) succeeded — it clears on success and sticks on failure.
	hasChanges.value = true;

	try {
		// Update local state immediately for UI feedback
		if (!translations.value[language]) {
			translations.value[language] = { subject: '', blocks: {} };
		}

		if (row.id === '_subject') {
			translations.value[language].subject = value;
		} else if (row.id === '_previewText') {
			translations.value[language].previewText = value;
		} else if (row.blockId) {
			const trans = translations.value[language];
			if (!trans.blocks) {
				trans.blocks = {};
			}
			if (!trans.blocks[row.blockId]) {
				trans.blocks[row.blockId] = {};
			}

			const blockTrans = trans.blocks[row.blockId]!;
			switch (row.fieldType) {
				case 'html':
					blockTrans.html = value;
					break;
				case 'buttonText':
					blockTrans.buttonText = value;
					break;
				case 'alt':
					blockTrans.alt = value;
					break;
			}
		}

		// Persist to database
		const saved = await saveTranslation(language);
		if (saved === undefined) return;
		await regenerateRenderedLanguage(language);
		hasChanges.value = false;
	} finally {
		savingCells.value.delete(cellKey);
	}
};

// Save translation to backend. Returns `undefined` when the save failed (the
// operation module has already surfaced the categorized error).
const saveTranslation = async (language: string) => {
	const translation = translations.value[language];
	if (!translation) return;

	if (props.emailType === 'marketing') {
		return await updateMarketingTranslation({
			templateId: props.emailId as Id<'emailTemplates'>,
			language,
			subject: translation.subject,
			previewText: translation.previewText,
			blocks: JSON.stringify(translation.blocks || {}),
		});
	}
	return await updateTransactionalTranslation({
		id: props.emailId as Id<'transactionalEmails'>,
		language,
		subject: translation.subject,
		blocks: JSON.stringify(translation.blocks || {}),
	});
};

// Add a new language
const addLanguage = async (langCode: string) => {
	isSaving.value = true;
	try {
		const added =
			props.emailType === 'marketing'
				? await addMarketingTranslation({
						templateId: props.emailId as Id<'emailTemplates'>,
						language: langCode,
					})
				: await addTransactionalTranslation({
						id: props.emailId as Id<'transactionalEmails'>,
						language: langCode,
					});
		if (added === undefined) return;
		await regenerateRenderedLanguage(langCode);
		showToast(`Added ${getLanguageInfo(langCode).label} translation`);
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
		const removed =
			props.emailType === 'marketing'
				? await removeMarketingTranslation({
						templateId: props.emailId as Id<'emailTemplates'>,
						language: langCode,
					})
				: await removeTransactionalTranslation({
						id: props.emailId as Id<'transactionalEmails'>,
						language: langCode,
					});
		if (removed === undefined) return;
		delete htmlTranslations.value[langCode];
		await persistHtmlTranslations();
		showToast(`Removed ${getLanguageInfo(langCode).label} translation`);
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
			showToast('All fields are already translated');
			return;
		}

		// Call AI translation action via Convex
		const result = await requireConvex().action(api.translate.translateBatch, {
			items: itemsToTranslate,
			sourceLanguage: getLanguageInfo(defaultLanguage.value).label,
			targetLanguage: getLanguageInfo(targetLanguage).label,
		});

		// Apply translations
		for (const item of result.translations) {
			const row = translatableRows.value.find((r) => r.id === item.id);
			if (row) {
				await updateTranslationValue(row, targetLanguage, item.translatedText);
			}
		}

		showToast(
			`Translated ${result.translations.length} fields to ${getLanguageInfo(targetLanguage).label}`
		);
	} catch (error) {
		showToast('Failed to auto-translate. Check API configuration.', 'error');
	} finally {
		isTranslating.value = null;
	}
};

// Navigation
const handleBack = () => {
	if (props.emailType === 'marketing') {
		router.push(`/dashboard/emails/${props.emailId}/edit`);
	} else {
		router.push(`/dashboard/transactional/${props.emailId}/edit`);
	}
};

// Check if a cell is currently saving
const isCellSaving = (rowId: string, language: string) => {
	return savingCells.value.has(`${rowId}:${language}`);
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
					class="p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors"
					@click="handleBack"
				 aria-label="Back">
					<Icon name="lucide:arrow-left" class="w-5 h-5" />
				</button>

				<div class="flex items-center gap-2">
					<Icon name="lucide:globe" class="w-5 h-5 text-text-tertiary" />
					<span class="text-text-primary font-medium">
						{{ email?.name || 'Email' }} - Translations
					</span>
				</div>
			</div>

			<div class="flex items-center gap-3">
				<span v-if="hasChanges" class="text-sm text-warning flex items-center gap-1.5">
					<Icon name="lucide:alert-circle" class="w-4 h-4" />
					Unsaved changes
				</span>
			</div>
		</div>

		<!-- Loading State -->
		<div v-if="isLoading" class="flex-1 flex items-center justify-center">
			<div class="flex flex-col items-center gap-3">
				<div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
				<p class="text-text-secondary text-sm">Loading email...</p>
			</div>
		</div>

		<!-- Not Found State -->
		<div v-else-if="!email" class="flex-1 flex items-center justify-center">
			<div class="text-center">
				<div class="w-12 h-12 text-error mx-auto mb-4">!</div>
				<h2 class="text-xl font-semibold text-text-primary mb-2">Email not found</h2>
				<p class="text-text-secondary mb-6">This email doesn't exist or has been deleted.</p>
				<UiButton @click="handleBack">Go Back</UiButton>
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
					<h3 class="text-lg font-medium text-text-primary mb-2">No translatable content</h3>
					<p class="text-text-secondary">
						Add text, buttons, or images with alt text to your email to enable translations.
					</p>
				</div>

				<!-- Translation Table -->
				<div v-else class="border border-border-subtle rounded-xl bg-bg-elevated overflow-hidden">
					<div class="overflow-x-auto">
						<table class="w-full">
							<thead>
								<tr class="border-b border-border-subtle bg-bg-surface/50">
									<!-- Field column -->
									<th
										class="px-4 py-3 text-left text-sm font-medium text-text-secondary sticky left-0 bg-bg-surface/50 min-w-[200px]"
									>
										Field
									</th>

									<!-- Default language column -->
									<th
										class="px-4 py-3 text-left text-sm font-medium text-text-secondary min-w-[250px]"
									>
										<div class="flex items-center gap-2">
											<span>{{ getLanguageInfo(defaultLanguage).nativeLabel }}</span>
											<span class="text-xs text-brand bg-brand/10 px-1.5 py-0.5 rounded"
												>default</span
											>
										</div>
									</th>

									<!-- Translation language columns -->
									<th
										v-for="lang in translationLanguages"
										:key="lang"
										class="px-4 py-3 text-left text-sm font-medium text-text-secondary min-w-[250px]"
									>
										<div class="flex items-center justify-between">
											<span>{{ getLanguageInfo(lang).nativeLabel }}</span>
											<div class="flex items-center gap-1">
												<button
													v-if="isTranslating !== lang"
													class="p-1 rounded hover:bg-brand/10 text-text-tertiary hover:text-brand transition-colors"
													title="Auto-translate with AI"
													@click="autoTranslateColumn(lang)"
												>
													<Icon name="lucide:sparkles" class="w-4 h-4" />
												</button>
												<div
													v-else
													class="w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin"
												/>
												<button
													class="p-1 rounded hover:bg-error/10 text-text-tertiary hover:text-error transition-colors"
													title="Remove language"
													@click="removeLanguage(lang)"
												>
													<Icon name="lucide:trash-2" class="w-4 h-4" />
												</button>
											</div>
										</div>
									</th>

									<!-- Add language column -->
									<th
										class="px-4 py-3 text-left text-sm font-medium text-text-secondary min-w-[150px]"
									>
										<UiDropdownMenu
											v-if="availableLanguages.length > 0"
											v-model:open="addLanguageDropdownOpen"
										>
											<template #trigger>
												<button
													class="flex items-center gap-1.5 px-2 py-1 text-sm rounded-lg border border-dashed border-border-default text-text-tertiary hover:text-text-primary hover:border-border-strong transition-colors"
													:disabled="isSaving"
												>
													<Icon name="lucide:plus" class="w-4 h-4" />
													Add Language
												</button>
											</template>

											<UiDropdownMenuItem
												v-for="lang in availableLanguages"
												:key="lang.value"
												@click="addLanguage(lang.value)"
											>
												<Icon name="lucide:globe" class="w-4 h-4" />
												{{ lang.label }} ({{ lang.nativeLabel }})
											</UiDropdownMenuItem>
										</UiDropdownMenu>
									</th>
								</tr>
							</thead>

							<tbody>
								<tr
									v-for="row in translatableRows"
									:key="row.id"
									class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface/30 transition-colors"
								>
									<!-- Field label -->
									<td
										class="px-4 py-3 text-sm text-text-secondary sticky left-0 bg-bg-elevated font-medium"
									>
										{{ row.label }}
										<span
											v-if="row.fieldType === 'html'"
											class="ml-1.5 text-xs text-text-tertiary bg-bg-surface px-1 py-0.5 rounded"
										>
											HTML
										</span>
									</td>

									<!-- Default language cell (read-only) -->
									<td class="px-4 py-3">
										<TranslationCell
											:value="row.sourceText"
											:is-html="row.fieldType === 'html'"
											:is-default="true"
										/>
									</td>

									<!-- Translation cells -->
									<td v-for="lang in translationLanguages" :key="lang" class="px-4 py-3">
										<TranslationCell
											:value="getTranslationValue(row, lang)"
											:is-html="row.fieldType === 'html'"
											:is-saving="isCellSaving(row.id, lang)"
											@save="(value: string) => updateTranslationValue(row, lang, value)"
										/>
									</td>

									<!-- Empty cell for add column -->
									<td class="px-4 py-3" />
								</tr>
							</tbody>
						</table>
					</div>
				</div>

				<!-- Info Card -->
				<div class="mt-6 p-4 bg-bg-surface border border-border-subtle rounded-xl">
					<div class="flex gap-3">
						<Icon name="lucide:globe" class="w-5 h-5 text-brand shrink-0 mt-0.5" />
						<div class="text-sm">
							<p class="text-text-primary font-medium mb-1">How translations work</p>
							<p class="text-text-secondary">
								Click any cell to edit the translation. Changes are saved automatically. Use the
								sparkle icon to auto-translate empty fields using AI. The default language content
								is read-only here - edit it in the main email editor.
							</p>
						</div>
					</div>
				</div>
			</div>
		<UiConfirmationDialog
			:open="!!languageToRemove"
			variant="danger"
			title="Remove translation?"
			:description="languageToRemove ? `Remove the ${getLanguageInfo(languageToRemove).label} translation? This cannot be undone.` : 'This cannot be undone.'"
			confirm-text="Remove translation"
			:is-loading="isSaving"
			@update:open="(v: boolean) => !v && (languageToRemove = null)"
			@confirm="confirmRemoveLanguage"
		/>
		</div>
	</div>
</template>
