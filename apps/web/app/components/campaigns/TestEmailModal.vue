<script setup lang="ts">
import { isValidEmail } from '~/utils/validation';
import type { Id } from '@owlat/api/dataModel';
import { api } from '@owlat/api';
import { languageOptions, formatLanguageLabel } from '~/data/languageOptions';

interface Props {
	open: boolean;
	campaignId: Id<'campaigns'> | null;
	subject?: string;
	fromName?: string;
	fromEmail?: string;
	/** Translated languages of the campaign's template; >1 shows the picker. */
	languages?: string[];
	defaultLanguage?: string;
}

const props = defineProps<Props>();

const getLanguageLabel = (code: string): string => {
	const opt = languageOptions.find((l) => l.value === code);
	return opt ? formatLanguageLabel(opt) : code;
};

const emit = defineEmits<{
	'update:open': [value: boolean];
}>();

const testEmailAddress = ref('');
const testEmailError = ref('');
const isSending = ref(false);
const emailSent = ref(false);
const testEmailLanguage = ref<string | undefined>(undefined);
const formRef = ref<HTMLFormElement | null>(null);

const validateTestEmail = (): boolean => {
	testEmailError.value = '';

	if (!testEmailAddress.value.trim()) {
		testEmailError.value = 'Email address is required';
		return false;
	}

	if (!isValidEmail(testEmailAddress.value.trim())) {
		testEmailError.value = 'Please enter a valid email address';
		return false;
	}

	return true;
};

const handleSendTestEmail = async () => {
	if (!validateTestEmail()) return;
	if (!props.campaignId) return;

	isSending.value = true;
	testEmailError.value = '';

	try {
		const convex = useConvex();
		if (!convex) throw new Error('Convex not initialized');

		await convex.action(api.campaigns.testSend.sendTestEmail, {
			campaignId: props.campaignId,
			testEmail: testEmailAddress.value,
			language: testEmailLanguage.value,
		});

		emailSent.value = true;
		setTimeout(() => {
			close();
		}, 2000);
	} catch (error) {
		testEmailError.value = error instanceof Error ? error.message : 'Failed to send test email';
	} finally {
		isSending.value = false;
	}
};

const close = () => {
	if (!isSending.value) {
		emit('update:open', false);
		// Reset state after close
		setTimeout(() => {
			testEmailAddress.value = '';
			testEmailError.value = '';
			testEmailLanguage.value = undefined;
			emailSent.value = false;
		}, 200);
	}
};

const submitForm = () => {
	formRef.value?.requestSubmit();
};
</script>

<template>
	<UiModal :open="open" title="Send Test Email" :persistent="isSending" @update:open="close">
		<!-- Success State -->
		<div v-if="emailSent" class="text-center py-8">
			<div
				class="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-4"
			>
				<Icon name="lucide:check-circle" class="w-8 h-8 text-success" />
			</div>
			<p class="text-lg font-medium text-text-primary">Test Email Sent!</p>
			<p class="text-sm text-text-secondary mt-2">Check your inbox at {{ testEmailAddress }}</p>
		</div>

		<!-- Form State -->
		<div v-else>
			<p class="text-sm text-text-secondary mb-4">
				Send a test email to preview how your campaign will look to recipients.
			</p>

			<!-- Test Email Summary -->
			<div v-if="subject || fromEmail" class="p-3 bg-bg-surface border border-border-subtle rounded-lg mb-4">
				<div class="text-sm">
					<p class="text-text-secondary">Subject:</p>
					<p class="font-medium text-text-primary">{{ subject }}</p>
				</div>
				<div class="text-sm mt-2">
					<p class="text-text-secondary">From:</p>
					<p class="font-medium text-text-primary">{{ fromName }} &lt;{{ fromEmail }}&gt;</p>
				</div>
			</div>

			<form ref="formRef" @submit.prevent="handleSendTestEmail">
				<div>
					<label for="testEmail" class="label">Recipient Email</label>
					<input
						id="testEmail"
						v-model="testEmailAddress"
						type="email"
						placeholder="you@example.com"
						:class="['input mt-1.5', testEmailError ? 'input-error' : '']"
						:disabled="isSending"
					/>
					<p v-if="testEmailError" class="mt-1.5 text-sm text-error">
						{{ testEmailError }}
					</p>
				</div>

				<!-- Language selector (only when the template has translations) -->
				<div v-if="(languages?.length ?? 0) > 1" class="mt-4">
					<label for="testEmailLanguage" class="label flex items-center gap-1.5">
						<Icon name="lucide:languages" class="w-4 h-4 text-text-tertiary" />
						Preview Language
					</label>
					<select
						id="testEmailLanguage"
						v-model="testEmailLanguage"
						class="input mt-1.5"
						:disabled="isSending"
					>
						<option :value="undefined">Default ({{ getLanguageLabel(defaultLanguage ?? 'en') }})</option>
						<option v-for="lang in languages" :key="lang" :value="lang">
							{{ getLanguageLabel(lang) }}
						</option>
					</select>
					<p class="mt-1.5 text-xs text-text-tertiary">
						Preview how the email looks in different languages.
					</p>
				</div>
			</form>
		</div>

		<template v-if="!emailSent" #footer>
			<UiModalFooter @cancel="close">
				<div class="flex justify-end gap-3">
					<UiButton variant="secondary" :disabled="isSending" @click="close">Cancel</UiButton>
					<UiButton :loading="isSending" :disabled="isSending" @click="submitForm">
						<template v-if="!isSending" #iconLeft><Icon name="lucide:send-horizonal" class="w-4 h-4" /></template>
						{{ isSending ? 'Sending...' : 'Send Test' }}
					</UiButton>
				</div>
			</UiModalFooter>
		</template>
	</UiModal>
</template>
