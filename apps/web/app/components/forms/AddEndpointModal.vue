<script setup lang="ts">
import type { FormFieldDraft } from '~/composables/useFormSettings';

// The forms admin page's "New form" modal. The draft, its validation and the
// create live in useFormSettings, which the page owns.
defineProps<{
	open: boolean;
	/** The page's add draft; the inputs write into it in place. */
	form: {
		name: string;
		topicId: string;
		redirectUrl: string;
		honeypotFieldName: string;
		doubleOptIn: boolean;
		fields: FormFieldDraft[];
	};
	errors: { name: string; fields: string };
	isAdding: boolean;
	topics: ReadonlyArray<{ _id: string; name: string }> | null | undefined;
	fieldEditor: {
		addField: () => void;
		removeField: (index: number) => void;
		moveField: (index: number, direction: -1 | 1) => void;
	};
}>();

const emit = defineEmits<{
	/** The modal was dismissed; the draft stays. */
	close: [];
	/** Cancel: close and reset the draft. */
	cancel: [];
	submit: [];
}>();

const { t } = useI18n();
</script>

<template>
	<UiModal
		:open="open"
		:title="t('dashboard.admin.instance.forms.addModal.title')"
		size="md"
		@update:open="
			(v) => {
				if (!v) emit('close');
			}
		"
	>
		<form id="add-form" @submit.prevent="emit('submit')">
			<div class="space-y-4">
				<!-- Name Input -->
				<div>
					<label for="form-name" class="label">
						{{ t('dashboard.admin.instance.forms.fields.name') }}
						<span class="text-error">*</span>
					</label>
					<input
						id="form-name"
						v-model="form.name"
						type="text"
						:placeholder="t('dashboard.admin.instance.forms.fields.namePlaceholder')"
						:class="['input', errors.name && 'input-error']"
						:disabled="isAdding"
					/>
					<p v-if="errors.name" class="mt-1 text-xs text-error">
						{{ errors.name }}
					</p>
				</div>

				<!-- Topic Select -->
				<div>
					<label for="form-topic" class="label">
						{{ t('dashboard.admin.instance.forms.fields.topic') }}
					</label>
					<select id="form-topic" v-model="form.topicId" class="input" :disabled="isAdding">
						<option value="">{{ t('dashboard.admin.instance.forms.fields.noTopic') }}</option>
						<option v-for="list in topics" :key="list._id" :value="list._id">
							{{ list.name }}
						</option>
					</select>
					<p class="mt-1 text-xs text-text-tertiary">
						{{ t('dashboard.admin.instance.forms.fields.topicHelp') }}
					</p>
				</div>

				<!-- Fields Editor -->
				<FormsFieldsEditor
					:fields="form.fields"
					:editor="fieldEditor"
					:error="errors.fields"
					:disabled="isAdding"
					id-prefix="add"
				/>

				<!-- Redirect URL -->
				<div>
					<label for="form-redirect" class="label">
						{{ t('dashboard.admin.instance.forms.fields.redirect') }}
					</label>
					<input
						id="form-redirect"
						v-model="form.redirectUrl"
						type="url"
						placeholder="https://example.com/thank-you"
						class="input"
						:disabled="isAdding"
					/>
					<p class="mt-1 text-xs text-text-tertiary">
						{{ t('dashboard.admin.instance.forms.fields.redirectHelp') }}
					</p>
				</div>

				<!-- Honeypot Field -->
				<div>
					<label for="form-honeypot" class="label">
						{{ t('dashboard.admin.instance.forms.fields.honeypot') }}
					</label>
					<input
						id="form-honeypot"
						v-model="form.honeypotFieldName"
						type="text"
						:placeholder="t('dashboard.admin.instance.forms.fields.honeypotPlaceholder')"
						class="input"
						:disabled="isAdding"
					/>
					<p class="mt-1 text-xs text-text-tertiary">
						{{ t('dashboard.admin.instance.forms.fields.honeypotHelp') }}
					</p>
				</div>

				<!-- Double Opt-In -->
				<div class="flex items-start gap-3 pt-2">
					<input
						id="form-double-optin"
						v-model="form.doubleOptIn"
						type="checkbox"
						class="mt-1 h-4 w-4 rounded border-border-default bg-bg-deep text-brand focus:ring-brand focus:ring-offset-0"
						:disabled="isAdding"
					/>
					<div>
						<label
							for="form-double-optin"
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
			<UiButton variant="secondary" type="button" :disabled="isAdding" @click="emit('cancel')">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton type="submit" form="add-form" class="gap-2" :disabled="isAdding">
				<Icon
					v-if="isAdding"
					name="lucide:loader-2"
					class="w-4 h-4 animate-spin motion-reduce:animate-none"
				/>
				<Icon v-else name="lucide:plus" class="w-4 h-4" />
				{{
					isAdding
						? t('dashboard.admin.instance.forms.addModal.creating')
						: t('dashboard.admin.instance.forms.addModal.create')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
