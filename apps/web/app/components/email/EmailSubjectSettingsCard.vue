<script setup lang="ts">
import { languageOptions } from '~/data/languageOptions';

defineProps<{ published: boolean }>();

const { t } = useI18n();

const emailType = defineModel<'marketing' | 'transactional'>('emailType', { required: true });
const defaultLanguage = defineModel<string>('defaultLanguage', { required: true });
const subject = defineModel<string>('subject', { required: true });
const previewText = defineModel<string>('previewText', { required: true });
</script>

<template>
	<UiCard>
		<div class="flex items-center gap-3 mb-6">
			<div class="p-2 rounded-lg bg-brand/10 flex items-center justify-center">
				<Icon name="lucide:mail" class="w-5 h-5 text-brand" />
			</div>
			<div>
				<h2 class="text-lg font-semibold text-text-primary">
					{{ t('components.email.emailSubjectSettingsCard.title') }}
				</h2>
				<p class="text-sm text-text-secondary">
					{{ t('components.email.emailSubjectSettingsCard.subtitle') }}
				</p>
			</div>
		</div>

		<div class="space-y-6">
			<UiSelect
				v-model="emailType"
				:label="t('components.email.emailSubjectSettingsCard.emailTypeLabel')"
				:disabled="published"
				:options="[
					{
						value: 'marketing',
						label: t('components.email.emailSubjectSettingsCard.emailTypes.marketing'),
					},
					{
						value: 'transactional',
						label: t('components.email.emailSubjectSettingsCard.emailTypes.transactional'),
					},
				]"
				:help-text="t('components.email.emailSubjectSettingsCard.emailTypeHelp')"
			/>
			<UiSelect
				v-model="defaultLanguage"
				:label="t('components.email.emailSubjectSettingsCard.defaultLanguageLabel')"
				:options="
					languageOptions.map((language) => ({
						value: language.value,
						label: t('components.email.emailSubjectSettingsCard.languageOption', {
							// `label` is a message key (the catalog is module scope), not copy.
							label: t(language.label),
							nativeLabel: language.nativeLabel,
						}),
					}))
				"
			/>
			<UiInput
				v-model="subject"
				:label="t('components.email.emailSubjectSettingsCard.subjectLabel')"
				:placeholder="t('components.email.emailSubjectSettingsCard.subjectPlaceholder')"
				:required="true"
				:help-text="t('components.email.emailSubjectSettingsCard.subjectHelp')"
			/>
			<UiTextarea
				v-model="previewText"
				:label="t('components.email.emailSubjectSettingsCard.previewTextLabel')"
				:placeholder="t('components.email.emailSubjectSettingsCard.previewTextPlaceholder')"
				:rows="2"
				:max-length="150"
				:help-text="t('components.email.emailSubjectSettingsCard.previewTextHelp')"
			/>
		</div>
	</UiCard>
</template>
