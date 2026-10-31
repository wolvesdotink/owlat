<script setup lang="ts">
import type { FormFieldDraft } from '~/composables/useFormSettings';

// The forms admin page's edit modal for one form endpoint. The draft, its
// validation and the save live in useFormSettings, which the page owns.
defineProps<{
	open: boolean;
	/** The page's edit draft; the inputs write into it in place. */
	form: {
		name: string;
		topicId: string;
		redirectUrl: string;
		honeypotFieldName: string;
		doubleOptIn: boolean;
		fields: FormFieldDraft[];
	};
	errors: { name: string; fields: string };
	isSaving: boolean;
	topics: ReadonlyArray<{ _id: string; name: string }> | null | undefined;
	fieldEditor: {
		addField: () => void;
		removeField: (index: number) => void;
		moveField: (index: number, direction: -1 | 1) => void;
	};
}>();

const emit = defineEmits<{ close: []; submit: [] }>();

const { t } = useI18n();
</script>

<template>
	<UiModal
		:open="open"
		:title="t('dashboard.admin.instance.forms.editModal.title')"
		size="md"
		@update:open="
			(v) => {
				if (!v) emit('close');
			}
		"
	>
		<form id="edit-form" @submit.prevent="emit('submit')">
			<div class="space-y-4">
				<!-- Name Input -->
				<div>
					<label for="edit-form-name" class="label">
						{{ t('dashboard.admin.instance.forms.fields.name') }}
						<span class="text-error">*</span>
					</label>
					<input
						id="edit-form-name"
						v-model="form.name"
						type="text"
						:placeholder="t('dashboard.admin.instance.forms.fields.namePlaceholder')"
						:class="['input', errors.name && 'input-error']"
						:disabled="isSaving"
					/>
					<p v-if="errors.name" class="mt-1 text-xs text-error">
						{{ errors.name }}
					</p>
				</div>

				<!-- Topic Select -->
				<div>
					<label for="edit-form-topic" class="label">
						{{ t('dashboard.admin.instance.forms.fields.topic') }}
					</label>
					<select id="edit-form-topic" v-model="form.topicId" class="input" :disabled="isSaving">
						<option value="">{{ t('dashboard.admin.instance.forms.fields.noTopic') }}</option>
						<option v-for="list in topics" :key="list._id" :value="list._id">
							{{ list.name }}
						</option>
					</select>
				</div>

				<!-- Fields Editor -->
				<FormsFieldsEditor
					:fields="form.fields"
					:editor="fieldEditor"
					:error="errors.fields"
					:disabled="isSaving"
					id-prefix="edit"
				/>

				<!-- Redirect URL -->
				<div>
					<label for="edit-form-redirect" class="label">
						{{ t('dashboard.admin.instance.forms.fields.redirect') }}
					</label>
					<input
						id="edit-form-redirect"
						v-model="form.redirectUrl"
						type="url"
						placeholder="https://example.com/thank-you"
						class="input"
						:disabled="isSaving"
					/>
				</div>

				<!-- Honeypot Field -->
				<div>
					<label for="edit-form-honeypot" class="label">
						{{ t('dashboard.admin.instance.forms.fields.honeypot') }}
					</label>
					<input
						id="edit-form-honeypot"
						v-model="form.honeypotFieldName"
						type="text"
						:placeholder="t('dashboard.admin.instance.forms.fields.honeypotPlaceholder')"
						class="input"
						:disabled="isSaving"
					/>
				</div>

				<!-- Double Opt-In -->
				<div class="flex items-start gap-3 pt-2">
					<input
						id="edit-form-double-optin"
						v-model="form.doubleOptIn"
						type="checkbox"
						class="mt-1 h-4 w-4 rounded border-border-default bg-bg-deep text-brand focus:ring-brand focus:ring-offset-0"
						:disabled="isSaving"
					/>
					<div>
						<label
							for="edit-form-double-optin"
							class="text-sm font-medium text-text-primary cursor-pointer"
						>
							{{ t('dashboard.admin.instance.forms.fields.doubleOptIn') }}
						</label>
						<p class="mt-0.5 text-xs text-text-tertiary">
							{{ t('dashboard.admin.instance.forms.fields.doubleOptInHelp') }}
						</p>
					</div>
				</div>
			</div>
		</form>

		<template #footer>
			<UiButton variant="secondary" type="button" :disabled="isSaving" @click="emit('close')">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton type="submit" form="edit-form" class="gap-2" :disabled="isSaving">
				<Icon
					v-if="isSaving"
					name="lucide:loader-2"
					class="w-4 h-4 animate-spin motion-reduce:animate-none"
				/>
				<Icon v-else name="lucide:check" class="w-4 h-4" />
				{{
					isSaving
						? t('dashboard.admin.instance.forms.editModal.saving')
						: t('dashboard.admin.instance.forms.editModal.save')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
