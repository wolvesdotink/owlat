<script setup lang="ts">
import type { FormFieldDraft } from '~/composables/useFormSettings';

// Editor for a form endpoint's ordered field list (key/label/type/required).
// The parent owns the reactive `fields` array and an `editor` of add/remove/move
// helpers that mutate it in place (from useFormSettings); this component only
// renders rows and v-models each field's properties. Auto-imports as
// <FormsFieldsEditor> (path-prefixed).
defineProps<{
	fields: FormFieldDraft[];
	editor: {
		addField: () => void;
		removeField: (index: number) => void;
		moveField: (index: number, direction: -1 | 1) => void;
	};
	error?: string;
	disabled?: boolean;
	idPrefix: string;
}>();

const { t } = useI18n();

// Message keys rather than text: the list is built once at setup, so a
// translated label here would freeze the locale active at mount.
const fieldTypes: Array<{ value: FormFieldDraft['type']; labelKey: string }> = [
	{ value: 'email', labelKey: 'components.forms.fieldsEditor.types.email' },
	{ value: 'text', labelKey: 'components.forms.fieldsEditor.types.text' },
	{ value: 'checkbox', labelKey: 'components.forms.fieldsEditor.types.checkbox' },
];
</script>

<template>
	<div>
		<div class="flex items-center justify-between mb-2">
			<label class="label mb-0">{{ t('components.forms.fieldsEditor.label') }}</label>
			<UiButton
				variant="ghost"
				type="button"
				class="gap-1.5 text-sm py-1 px-2"
				:disabled="disabled"
				@click="editor.addField()"
			>
				<Icon name="lucide:plus" class="w-4 h-4" />
				{{ t('components.forms.fieldsEditor.addField') }}
			</UiButton>
		</div>

		<I18nT
			keypath="components.forms.fieldsEditor.help"
			tag="p"
			scope="global"
			class="mb-3 text-xs text-text-tertiary"
		>
			<template #firstName><code>firstName</code></template>
			<template #lastName><code>lastName</code></template>
			<template #email><code>email</code></template>
		</I18nT>

		<div class="space-y-3">
			<div
				v-for="(field, index) in fields"
				:key="index"
				class="rounded-lg border border-border-subtle bg-bg-surface/40 p-3"
			>
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
					<div>
						<label :for="`${idPrefix}-field-key-${index}`" class="text-xs text-text-tertiary">
							{{ t('components.forms.fieldsEditor.keyLabel') }}
						</label>
						<input
							:id="`${idPrefix}-field-key-${index}`"
							v-model="field.key"
							type="text"
							:placeholder="t('components.forms.fieldsEditor.keyPlaceholder')"
							class="input"
							:disabled="disabled"
						/>
					</div>
					<div>
						<label :for="`${idPrefix}-field-label-${index}`" class="text-xs text-text-tertiary">
							{{ t('components.forms.fieldsEditor.labelLabel') }}
						</label>
						<input
							:id="`${idPrefix}-field-label-${index}`"
							v-model="field.label"
							type="text"
							:placeholder="t('components.forms.fieldsEditor.labelPlaceholder')"
							class="input"
							:disabled="disabled"
						/>
					</div>
				</div>

				<div class="flex items-center justify-between mt-2 gap-3 flex-wrap">
					<div class="flex items-center gap-3">
						<div>
							<label :for="`${idPrefix}-field-type-${index}`" class="sr-only">
								{{ t('components.forms.fieldsEditor.typeLabel') }}
							</label>
							<select
								:id="`${idPrefix}-field-type-${index}`"
								v-model="field.type"
								class="input py-1.5"
								:disabled="disabled"
							>
								<option
									v-for="fieldType in fieldTypes"
									:key="fieldType.value"
									:value="fieldType.value"
								>
									{{ t(fieldType.labelKey) }}
								</option>
							</select>
						</div>
						<label class="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
							<input
								v-model="field.required"
								type="checkbox"
								class="h-4 w-4 rounded border-border-default bg-bg-deep text-brand focus:ring-brand focus:ring-offset-0"
								:disabled="disabled"
							/>
							{{ t('common.required') }}
						</label>
					</div>

					<div class="flex items-center gap-1">
						<UiButton
							variant="ghost"
							type="button"
							class="p-1.5"
							:title="t('components.forms.fieldsEditor.moveUp')"
							:disabled="disabled || index === 0"
							@click="editor.moveField(index, -1)"
						>
							<Icon name="lucide:arrow-up" class="w-4 h-4" />
						</UiButton>
						<UiButton
							variant="ghost"
							type="button"
							class="p-1.5"
							:title="t('components.forms.fieldsEditor.moveDown')"
							:disabled="disabled || index === fields.length - 1"
							@click="editor.moveField(index, 1)"
						>
							<Icon name="lucide:arrow-down" class="w-4 h-4" />
						</UiButton>
						<UiButton
							variant="ghost"
							type="button"
							class="p-1.5 text-error hover:bg-error/10"
							:title="t('components.forms.fieldsEditor.removeField')"
							:disabled="disabled || fields.length === 1"
							@click="editor.removeField(index)"
						>
							<Icon name="lucide:trash-2" class="w-4 h-4" />
						</UiButton>
					</div>
				</div>
			</div>
		</div>

		<p v-if="error" class="mt-2 text-xs text-error">{{ error }}</p>
	</div>
</template>
