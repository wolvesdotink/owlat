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

const fieldTypes: Array<{ value: FormFieldDraft['type']; label: string }> = [
	{ value: 'email', label: 'Email' },
	{ value: 'text', label: 'Text' },
	{ value: 'checkbox', label: 'Checkbox' },
];
</script>

<template>
	<div>
		<div class="flex items-center justify-between mb-2">
			<label class="label mb-0">Fields</label>
			<button
				type="button"
				class="btn btn-ghost gap-1.5 text-sm py-1 px-2"
				:disabled="disabled"
				@click="editor.addField()"
			>
				<Icon name="lucide:plus" class="w-4 h-4" />
				Add field
			</button>
		</div>

		<p class="mb-3 text-xs text-text-tertiary">
			Each field becomes an input in the embedded form. <code>firstName</code> and
			<code>lastName</code> keys map onto the contact; <code>email</code> is required.
		</p>

		<div class="space-y-3">
			<div
				v-for="(field, index) in fields"
				:key="index"
				class="rounded-lg border border-border-subtle bg-bg-surface/40 p-3"
			>
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
					<div>
						<label :for="`${idPrefix}-field-key-${index}`" class="text-xs text-text-tertiary">
							Key
						</label>
						<input
							:id="`${idPrefix}-field-key-${index}`"
							v-model="field.key"
							type="text"
							placeholder="e.g., firstName"
							class="input"
							:disabled="disabled"
						/>
					</div>
					<div>
						<label :for="`${idPrefix}-field-label-${index}`" class="text-xs text-text-tertiary">
							Label
						</label>
						<input
							:id="`${idPrefix}-field-label-${index}`"
							v-model="field.label"
							type="text"
							placeholder="e.g., First name"
							class="input"
							:disabled="disabled"
						/>
					</div>
				</div>

				<div class="flex items-center justify-between mt-2 gap-3 flex-wrap">
					<div class="flex items-center gap-3">
						<div>
							<label :for="`${idPrefix}-field-type-${index}`" class="sr-only">Type</label>
							<select
								:id="`${idPrefix}-field-type-${index}`"
								v-model="field.type"
								class="input py-1.5"
								:disabled="disabled"
							>
								<option v-for="t in fieldTypes" :key="t.value" :value="t.value">
									{{ t.label }}
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
							Required
						</label>
					</div>

					<div class="flex items-center gap-1">
						<button
							type="button"
							class="btn btn-ghost p-1.5"
							title="Move up"
							:disabled="disabled || index === 0"
							@click="editor.moveField(index, -1)"
						>
							<Icon name="lucide:arrow-up" class="w-4 h-4" />
						</button>
						<button
							type="button"
							class="btn btn-ghost p-1.5"
							title="Move down"
							:disabled="disabled || index === fields.length - 1"
							@click="editor.moveField(index, 1)"
						>
							<Icon name="lucide:arrow-down" class="w-4 h-4" />
						</button>
						<button
							type="button"
							class="btn btn-ghost p-1.5 text-error hover:bg-error/10"
							title="Remove field"
							:disabled="disabled || fields.length === 1"
							@click="editor.removeField(index)"
						>
							<Icon name="lucide:trash-2" class="w-4 h-4" />
						</button>
					</div>
				</div>
			</div>
		</div>

		<p v-if="error" class="mt-2 text-xs text-error">{{ error }}</p>
	</div>
</template>
