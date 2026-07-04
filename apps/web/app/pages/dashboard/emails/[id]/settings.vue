<script setup lang="ts">
import { api } from '@owlat/api';
import { languageOptions } from '~/data/languageOptions';
import { emailSettingsSave } from '~/composables/emailSettingsSave';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Email Settings — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();
const router = useRouter();
const templateId = route.params['id'] as Id<'emailTemplates'>;
const { showToast } = useToast();

// Fetch template data
const { data: template, isLoading: templateLoading } = useConvexQuery(
	api.emailTemplates.emails.get,
	() => ({ templateId })
);

// Mutations
const { run: updateTemplate } = useBackendOperation(api.emailTemplates.emails.update, {
	label: 'Save settings',
});
// Changing the default language re-keys subject/preview/body — it must route
// through `setDefaultLanguage` (which promotes the chosen overlay and demotes
// the old default), not a plain field patch.
const { run: promoteDefaultLanguage } = useBackendOperation(
	api.emailTemplates.i18n.setDefaultLanguage,
	{ label: 'Change default language' }
);

// Common languages for dropdown

// Form state
const form = reactive({
	subject: '',
	previewText: '',
	defaultLanguage: 'en',
	supportedLanguages: [] as string[],
});

// Translations keyed by language code (only the fields this page edits)
const translations = ref<Record<string, { subject: string; previewText: string }>>({});

// Full per-language translation payload as last persisted (subject/previewText
// PLUS fields this page does not edit, e.g. `blocks` written by the Translation
// Manager). Retained so saving here never drops them.
const rawTranslations = ref<Record<string, Record<string, unknown>>>({});

// Track changes
const hasChanges = ref(false);
const isSaving = ref(false);

// The default language as last persisted. Changing the form's defaultLanguage
// away from this triggers the content-swapping `setDefaultLanguage` path.
const persistedDefaultLanguage = ref('en');

// Currently selected language for editing
const selectedLanguage = ref<string | null>(null);

// Computed: selected translation object (for type safety)
const selectedTranslation = computed(() => {
	if (!selectedLanguage.value) return null;
	return translations.value[selectedLanguage.value] || null;
});

// Computed: available languages to add (not yet in supportedLanguages)
const availableLanguages = computed(() => {
	return languageOptions.filter(
		(lang) => !form.supportedLanguages.includes(lang.value) && lang.value !== form.defaultLanguage
	);
});

// Get language label
const getLanguageLabel = (code: string) => {
	const lang = languageOptions.find((l) => l.value === code);
	return lang ? `${lang.label} (${lang.nativeLabel})` : code;
};

// Get language native label
const getLanguageNativeLabel = (code: string) => {
	const lang = languageOptions.find((l) => l.value === code);
	return lang?.nativeLabel || code;
};

// Initialize from template
watch(
	template,
	(t) => {
		if (t) {
			form.subject = t.subject || '';
			form.previewText = t.previewText || '';
			form.defaultLanguage = t.defaultLanguage || 'en';
			persistedDefaultLanguage.value = t.defaultLanguage || 'en';
			form.supportedLanguages = [...(t.supportedLanguages || [])];

			// Parse translations
			if (t.translations) {
				try {
					const parsed = JSON.parse(t.translations);
					// Extract the editable fields, but retain the full payload per
					// language so non-edited fields (e.g. `blocks`) survive a save.
					for (const lang of Object.keys(parsed)) {
						const entry = parsed[lang] && typeof parsed[lang] === 'object' ? parsed[lang] : {};
						rawTranslations.value[lang] = { ...entry };
						translations.value[lang] = {
							subject: entry.subject || '',
							previewText: entry.previewText || '',
						};
					}
				} catch {
					translations.value = {};
					rawTranslations.value = {};
				}
			}

			hasChanges.value = false;
		}
	},
	{ immediate: true }
);

// Track changes
watch(
	[() => form, translations],
	() => {
		hasChanges.value = true;
	},
	{ deep: true }
);

// Add language
const addLanguage = (langCode: string) => {
	if (!form.supportedLanguages.includes(langCode)) {
		form.supportedLanguages.push(langCode);
		translations.value[langCode] = { subject: '', previewText: '' };
		rawTranslations.value[langCode] = {};
		selectedLanguage.value = langCode;
	}
};

// Remove language
const removeLanguage = (langCode: string) => {
	form.supportedLanguages = form.supportedLanguages.filter((l) => l !== langCode);
	delete translations.value[langCode];
	delete rawTranslations.value[langCode];
	if (selectedLanguage.value === langCode) {
		selectedLanguage.value = null;
	}
};

// Build translations JSON for saving
const buildTranslationsJson = () => {
	const result: Record<string, Record<string, unknown>> = {};
	for (const lang of form.supportedLanguages) {
		if (translations.value[lang]) {
			// Merge the editable fields onto the retained payload so per-block
			// translations (and any other fields) are preserved, not overwritten.
			result[lang] = {
				...rawTranslations.value[lang],
				subject: translations.value[lang].subject,
				previewText: translations.value[lang].previewText,
			};
		}
	}
	return JSON.stringify(result);
};

// Save handler
const handleSave = async () => {
	isSaving.value = true;
	try {
		const outcome = await emailSettingsSave({
			persistedDefaultLanguage: persistedDefaultLanguage.value,
			selectedDefaultLanguage: form.defaultLanguage,
			// Promotable targets are the languages this save will persist an
			// overlay for. `buildTranslationsJson()` writes exactly the supported
			// languages present in `translations.value`, and `emailSettingsSave`
			// persists that payload (step 1) before the swap (step 2) — so a
			// just-added overlay is a valid target without needing a prior save.
			overlayLanguages: Object.keys(translations.value),
			updatePayload: {
				subject: form.subject,
				previewText: form.previewText || undefined,
				defaultLanguage: form.defaultLanguage,
				supportedLanguages: form.supportedLanguages,
				translations: buildTranslationsJson(),
			},
			update: (payload) => updateTemplate({ templateId, ...payload }),
			setDefaultLanguage: ({ language }) => promoteDefaultLanguage({ templateId, language }),
		});

		switch (outcome.status) {
			case 'failed':
				// The mutation already surfaced its own error toast.
				return;
			case 'no-overlay':
				showToast(
					`Add a ${getLanguageNativeLabel(outcome.language)} translation before making it the default language.`,
					'error'
				);
				return;
			case 'language-promoted':
				// `setDefaultLanguage` re-keyed subject/preview/body; the live query
				// reloads the form. Reflect the new default so a follow-up save is a
				// plain patch, not another (now no-op) swap attempt.
				persistedDefaultLanguage.value = form.defaultLanguage;
				hasChanges.value = false;
				showToast('Default language updated');
				return;
			case 'saved':
				hasChanges.value = false;
				showToast('Settings saved successfully');
				return;
		}
	} finally {
		isSaving.value = false;
	}
};

// Navigation
const handleBack = () => {
	router.push(`/dashboard/emails/${templateId}/edit`);
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
					aria-label="Back"
				>
					<Icon name="lucide:arrow-left" class="w-5 h-5" />
				</button>

				<div class="flex items-center gap-2">
					<Icon name="lucide:settings" class="w-5 h-5 text-text-tertiary" />
					<span class="text-text-primary font-medium">Email Settings</span>
				</div>
			</div>

			<div class="flex items-center gap-3">
				<span v-if="hasChanges" class="text-sm text-warning flex items-center gap-1.5">
					<Icon name="lucide:alert-circle" class="w-4 h-4" />
					Unsaved changes
				</span>
				<UiButton :loading="isSaving" :disabled="!hasChanges" @click="handleSave">
					<template #iconLeft>
						<Icon v-if="!isSaving" name="lucide:check" class="w-4 h-4" />
					</template>
					{{ isSaving ? 'Saving...' : 'Save Changes' }}
				</UiButton>
			</div>
		</div>

		<!-- Loading State -->
		<div v-if="templateLoading" class="flex-1 flex items-center justify-center">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading template...</p>
			</div>
		</div>

		<!-- Not Found State -->
		<div v-else-if="!template" class="flex-1 flex items-center justify-center">
			<div class="text-center">
				<div class="w-12 h-12 text-error mx-auto mb-4">!</div>
				<h2 class="text-xl font-semibold text-text-primary mb-2">Template not found</h2>
				<p class="text-text-secondary mb-6">
					This email template doesn't exist or has been deleted.
				</p>
				<UiButton @click="router.push('/dashboard/mail/marketing')">Back to Emails</UiButton>
			</div>
		</div>

		<!-- Settings Content -->
		<div v-else class="flex-1 overflow-y-auto p-6 lg:p-8">
			<div class="max-w-3xl mx-auto space-y-8">
				<!-- Default Language Subject & Preview -->
				<UiCard>
					<div class="flex items-center gap-3 mb-6">
						<div class="p-2 rounded-lg bg-brand/10 flex items-center justify-center">
							<Icon name="lucide:mail" class="w-5 h-5 text-brand" />
						</div>
						<div>
							<h2 class="text-lg font-semibold text-text-primary">Subject & Preview Text</h2>
							<p class="text-sm text-text-secondary">
								The subject line and preview text for your default language
							</p>
						</div>
					</div>

					<div class="space-y-6">
						<!-- Default Language Selector -->
						<UiSelect
							v-model="form.defaultLanguage"
							label="Default Language"
							:options="
								languageOptions.map((l) => ({
									value: l.value,
									label: `${l.label} (${l.nativeLabel})`,
								}))
							"
						/>

						<!-- Subject -->
						<UiInput
							v-model="form.subject"
							label="Subject Line"
							placeholder="Enter email subject line"
							:required="true"
							help-text="The subject line recipients will see in their inbox."
						/>

						<!-- Preview Text -->
						<UiTextarea
							v-model="form.previewText"
							label="Preview Text"
							placeholder="Enter preview text (optional)"
							:rows="2"
							:max-length="150"
							help-text="The preview text appears after the subject line in email clients. Keep it under 150 characters."
						/>
					</div>
				</UiCard>

				<!-- Translations Section -->
				<UiCard>
					<div class="flex items-center justify-between mb-6">
						<div class="flex items-center gap-3">
							<div class="p-2 rounded-lg bg-brand/10 flex items-center justify-center">
								<Icon name="lucide:languages" class="w-5 h-5 text-brand" />
							</div>
							<div>
								<h2 class="text-lg font-semibold text-text-primary">Translations</h2>
								<p class="text-sm text-text-secondary">
									Add translated subject lines and preview text for different languages
								</p>
							</div>
						</div>

						<!-- Add Language Dropdown -->
						<UiDropdownMenu v-if="availableLanguages.length > 0">
							<template #trigger>
								<UiButton variant="secondary" size="sm">
									<template #iconLeft>
										<Icon name="lucide:plus" class="w-4 h-4" />
									</template>
									Add Language
								</UiButton>
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
					</div>

					<!-- Empty State -->
					<div
						v-if="form.supportedLanguages.length === 0"
						class="text-center py-8 border border-dashed border-border-subtle rounded-xl"
					>
						<Icon name="lucide:globe" class="w-8 h-8 text-text-tertiary mx-auto mb-3" />
						<p class="text-text-secondary mb-1">No translations added yet</p>
						<p class="text-sm text-text-tertiary">
							Add languages to provide translated subject lines and preview text
						</p>
					</div>

					<!-- Language Tabs -->
					<div v-else>
						<!-- Language Pills -->
						<div class="flex flex-wrap gap-2 mb-6">
							<div
								v-for="langCode in form.supportedLanguages"
								:key="langCode"
								:class="[
									'group flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors cursor-pointer',
									selectedLanguage === langCode
										? 'bg-brand/10 border-brand text-brand'
										: 'bg-bg-surface border-border-default text-text-secondary hover:border-border-strong',
								]"
								@click="selectedLanguage = langCode"
							>
								<span class="text-sm font-medium">{{ getLanguageNativeLabel(langCode) }}</span>
								<button
									class="p-0.5 rounded hover:bg-error/20 hover:text-error transition-colors"
									title="Remove language"
									@click.stop="removeLanguage(langCode)"
								>
									<Icon name="lucide:trash-2" class="w-3 h-3" />
								</button>
							</div>
						</div>

						<!-- Selected Language Editor -->
						<Transition name="fade" mode="out-in">
							<div
								v-if="selectedLanguage && selectedTranslation"
								:key="selectedLanguage"
								class="border border-border-subtle rounded-xl p-6 bg-bg-surface/50"
							>
								<div class="flex items-center gap-2 mb-4">
									<Icon name="lucide:globe" class="w-4 h-4 text-brand" />
									<h3 class="font-medium text-text-primary">
										{{ getLanguageLabel(selectedLanguage) }}
									</h3>
								</div>

								<div class="space-y-4">
									<UiInput
										v-model="selectedTranslation.subject"
										label="Subject Line"
										:placeholder="`Subject in ${getLanguageNativeLabel(selectedLanguage)}`"
										help-text="Leave empty to use the default subject."
									/>

									<UiTextarea
										v-model="selectedTranslation.previewText"
										label="Preview Text"
										:placeholder="`Preview text in ${getLanguageNativeLabel(selectedLanguage)}`"
										:rows="2"
										:max-length="150"
										help-text="Leave empty to use the default preview text."
									/>
								</div>
							</div>

							<div
								v-else
								class="border border-dashed border-border-subtle rounded-xl p-8 text-center"
							>
								<p class="text-text-secondary">Select a language above to edit its translation</p>
							</div>
						</Transition>
					</div>
				</UiCard>

				<!-- Info Card -->
				<UiCard variant="info">
					<div class="flex gap-3">
						<Icon name="lucide:globe" class="w-5 h-5 text-brand shrink-0 mt-0.5" />
						<div class="text-sm">
							<p class="text-text-primary font-medium mb-1">How translations work</p>
							<p class="text-text-secondary">
								When sending an email, the system checks each recipient's language preference. If a
								translation exists for their language, they'll receive the translated subject and
								preview text. Otherwise, they'll receive the default language content.
							</p>
						</div>
					</div>
				</UiCard>
			</div>
		</div>
	</div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
	transition: opacity var(--motion-fast) var(--ease-spring);
}

.fade-enter-from,
.fade-leave-to {
	opacity: 0;
}
</style>
