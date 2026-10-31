<script setup lang="ts">
import { api } from '@owlat/api';
import { isValidEmail } from '@owlat/shared';
import { languageSelectOptions } from '~/data/languageOptions';
import type { UseFormModalReturn } from '~/composables/useFormModal';

type AddContactForm = {
	email: string;
	firstName: string;
	lastName: string;
	language: string;
};

// The contacts list's Add contact modal: validates the address and creates the
// contact. The page owns the open state (the `?action=add` link, the New
// shortcut and Escape all reach it).
const props = defineProps<{
	addModal: UseFormModalReturn<AddContactForm>;
}>();

const { t } = useI18n();
const { showToast } = useToast();

const { run: createContact } = useBackendOperation(api.contacts.contacts.create, {
	label: () => t('dashboard.audience.contacts.index.operations.addContact'),
});

// The language catalog is module scope, so it carries message keys: the
// `{ value, label }` pairs the picker renders can only be built here, where a
// translator is in hand. Computed, so the labels follow a locale switch.
const languageChoices = computed(() => languageSelectOptions((key: string) => t(key)));

const validateAddForm = (): boolean => {
	const addModal = props.addModal;
	addModal.clearErrors();
	if (!addModal.form.email.trim()) {
		addModal.errors.email = t('auth.validation.emailRequired');
		return false;
	}
	if (!isValidEmail(addModal.form.email.trim())) {
		addModal.errors.email = t('auth.validation.emailInvalid');
		return false;
	}
	return true;
};

const handleAddSubmit = async () => {
	const addModal = props.addModal;
	if (!validateAddForm()) return;
	addModal.isSubmitting.value = true;

	const result = await createContact({
		email: addModal.form.email.trim(),
		firstName: addModal.form.firstName.trim() || undefined,
		lastName: addModal.form.lastName.trim() || undefined,
		language: addModal.form.language || undefined,
		source: 'form',
	});
	addModal.isSubmitting.value = false;
	if (!result.ok) return;
	showToast(
		t('dashboard.audience.contacts.index.toasts.created', { email: addModal.form.email.trim() })
	);
	addModal.close();
};
</script>

<template>
	<UiModal
		v-model:open="addModal.isOpen.value"
		:title="t('dashboard.audience.contacts.index.addContact')"
	>
		<form @submit.prevent="handleAddSubmit">
			<div
				v-if="addModal.errors.general"
				class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20"
			>
				<p class="text-sm text-error">{{ addModal.errors.general }}</p>
			</div>
			<div class="mb-4">
				<UiInput
					v-model="addModal.form.email"
					type="email"
					:label="t('common.email')"
					:required="true"
					:placeholder="t('dashboard.audience.contacts.index.form.emailPlaceholder')"
					:error="addModal.errors.email"
					:disabled="addModal.isSubmitting.value"
				/>
			</div>
			<div class="mb-4">
				<UiInput
					v-model="addModal.form.firstName"
					:label="t('dashboard.audience.contacts.index.table.firstName')"
					:placeholder="t('dashboard.audience.contacts.index.form.firstNamePlaceholder')"
					:disabled="addModal.isSubmitting.value"
				/>
			</div>
			<div class="mb-4">
				<UiInput
					v-model="addModal.form.lastName"
					:label="t('dashboard.audience.contacts.index.table.lastName')"
					:placeholder="t('dashboard.audience.contacts.index.form.lastNamePlaceholder')"
					:disabled="addModal.isSubmitting.value"
				/>
			</div>
			<div class="mb-6">
				<UiSelect
					v-model="addModal.form.language"
					:options="languageChoices"
					:label="t('dashboard.audience.contacts.index.form.languageLabel')"
					:placeholder="t('dashboard.audience.contacts.index.form.languagePlaceholder')"
					:disabled="addModal.isSubmitting.value"
				/>
			</div>
		</form>
		<template #footer>
			<UiButton
				variant="secondary"
				:disabled="addModal.isSubmitting.value"
				@click="addModal.close()"
				>{{ t('common.cancel') }}</UiButton
			>
			<UiButton :loading="addModal.isSubmitting.value" @click="handleAddSubmit">{{
				addModal.isSubmitting.value
					? t('dashboard.audience.contacts.index.creating')
					: t('dashboard.audience.contacts.index.createContact')
			}}</UiButton>
		</template>
	</UiModal>
</template>
