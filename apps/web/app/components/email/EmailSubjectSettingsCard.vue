<script setup lang="ts">
import { languageOptions } from '~/data/languageOptions';

defineProps<{ published: boolean }>();

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
				<h2 class="text-lg font-semibold text-text-primary">Subject & Preview Text</h2>
				<p class="text-sm text-text-secondary">
					The subject line and preview text for your default language
				</p>
			</div>
		</div>

		<div class="space-y-6">
			<UiSelect
				v-model="emailType"
				label="Email type"
				:disabled="published"
				:options="[
					{ value: 'marketing', label: 'Marketing' },
					{ value: 'transactional', label: 'Transactional' },
				]"
				help-text="Unpublish this email before changing its type."
			/>
			<UiSelect
				v-model="defaultLanguage"
				label="Default Language"
				:options="
					languageOptions.map((language) => ({
						value: language.value,
						label: `${language.label} (${language.nativeLabel})`,
					}))
				"
			/>
			<UiInput
				v-model="subject"
				label="Subject Line"
				placeholder="Enter email subject line"
				:required="true"
				help-text="The subject line recipients will see in their inbox."
			/>
			<UiTextarea
				v-model="previewText"
				label="Preview Text"
				placeholder="Enter preview text (optional)"
				:rows="2"
				:max-length="150"
				help-text="The preview text appears after the subject line in email clients. Keep it under 150 characters."
			/>
		</div>
	</UiCard>
</template>
