<script setup lang="ts">
/**
 * Per-language subject / preview-text editor for an email template.
 *
 * The card owns only the picking: which languages are offered (everything in
 * the catalog that is neither already supported nor the default), and which one
 * is currently open. The template's own state stays with the settings page,
 * which also holds the untouched rest of each language's payload — so adding or
 * removing a language is a REQUEST here (`add-language` / `remove-language`),
 * not a local edit.
 *
 * `translations` is a model rather than a prop because the two fields this card
 * edits are written straight into the page's per-language map, whose deep watch
 * is what marks the settings page dirty.
 */
import { languageOptions } from '~/data/languageOptions';

const props = defineProps<{
	/** Language codes the template currently carries overlays for. */
	supportedLanguages: string[];
	/** The template's default language — its copy lives on the template itself. */
	defaultLanguage: string;
}>();

/** The editable slice of each overlay, keyed by language code. */
const translations = defineModel<Record<string, { subject: string; previewText: string }>>(
	'translations',
	{ required: true }
);

const emit = defineEmits<{
	/** Add an overlay for this language (the page seeds its payload). */
	'add-language': [code: string];
	/** Drop this language's overlay entirely. */
	'remove-language': [code: string];
}>();

const { t } = useI18n();

/** Currently open language tab; null until one is picked. */
const selectedLanguage = ref<string | null>(null);

// Languages still available to add: not already supported, and not the default
// (whose copy is edited on the template itself, not as an overlay).
const availableLanguages = computed(() =>
	languageOptions.filter(
		(lang) => !props.supportedLanguages.includes(lang.value) && lang.value !== props.defaultLanguage
	)
);

const selectedTranslation = computed(() => {
	if (!selectedLanguage.value) return null;
	return translations.value[selectedLanguage.value] || null;
});

const getLanguageLabel = (code: string) => {
	const lang = languageOptions.find((l) => l.value === code);
	return lang
		? t('dashboard.send.emails.detail.settings.languageWithNative', {
				label: t(lang.label),
				native: lang.nativeLabel,
			})
		: code;
};

const getLanguageNativeLabel = (code: string) => {
	const lang = languageOptions.find((l) => l.value === code);
	return lang?.nativeLabel || code;
};

// Opening the language just added is the point of adding it.
const addLanguage = (langCode: string) => {
	emit('add-language', langCode);
	selectedLanguage.value = langCode;
};

const removeLanguage = (langCode: string) => {
	emit('remove-language', langCode);
	if (selectedLanguage.value === langCode) {
		selectedLanguage.value = null;
	}
};
</script>

<template>
	<UiCard>
		<div class="flex items-center justify-between mb-6">
			<div class="flex items-center gap-3">
				<div class="p-2 rounded-lg bg-brand/10 flex items-center justify-center">
					<Icon name="lucide:languages" class="w-5 h-5 text-brand" />
				</div>
				<div>
					<h2 class="text-lg font-semibold text-text-primary">
						{{ t('dashboard.send.emails.detail.settings.translations.title') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('dashboard.send.emails.detail.settings.translations.description') }}
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
						{{ t('dashboard.send.emails.detail.settings.translations.addLanguage') }}
					</UiButton>
				</template>

				<UiDropdownMenuItem
					v-for="lang in availableLanguages"
					:key="lang.value"
					@click="addLanguage(lang.value)"
				>
					<Icon name="lucide:globe" class="w-4 h-4" />
					{{
						t('dashboard.send.emails.detail.settings.languageWithNative', {
							label: t(lang.label),
							native: lang.nativeLabel,
						})
					}}
				</UiDropdownMenuItem>
			</UiDropdownMenu>
		</div>

		<!-- Empty State -->
		<div
			v-if="supportedLanguages.length === 0"
			class="text-center py-8 border border-dashed border-border-subtle rounded-xl"
		>
			<Icon name="lucide:globe" class="w-8 h-8 text-text-tertiary mx-auto mb-3" />
			<p class="text-text-secondary mb-1">
				{{ t('dashboard.send.emails.detail.settings.translations.emptyTitle') }}
			</p>
			<p class="text-sm text-text-tertiary">
				{{ t('dashboard.send.emails.detail.settings.translations.emptyDescription') }}
			</p>
		</div>

		<!-- Language Tabs -->
		<div v-else>
			<!-- Language Pills -->
			<div class="flex flex-wrap gap-2 mb-6">
				<div
					v-for="langCode in supportedLanguages"
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
						:title="t('dashboard.send.emails.detail.settings.translations.removeLanguage')"
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
							:label="t('dashboard.send.emails.detail.settings.translations.subjectLabel')"
							:placeholder="
								t('dashboard.send.emails.detail.settings.translations.subjectPlaceholder', {
									language: getLanguageNativeLabel(selectedLanguage),
								})
							"
							:help-text="t('dashboard.send.emails.detail.settings.translations.subjectHelp')"
						/>

						<UiTextarea
							v-model="selectedTranslation.previewText"
							:label="t('dashboard.send.emails.detail.settings.translations.previewLabel')"
							:placeholder="
								t('dashboard.send.emails.detail.settings.translations.previewPlaceholder', {
									language: getLanguageNativeLabel(selectedLanguage),
								})
							"
							:rows="2"
							:max-length="150"
							:help-text="t('dashboard.send.emails.detail.settings.translations.previewHelp')"
						/>
					</div>
				</div>

				<div v-else class="border border-dashed border-border-subtle rounded-xl p-8 text-center">
					<p class="text-text-secondary">
						{{ t('dashboard.send.emails.detail.settings.translations.selectPrompt') }}
					</p>
				</div>
			</Transition>
		</div>
	</UiCard>
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
