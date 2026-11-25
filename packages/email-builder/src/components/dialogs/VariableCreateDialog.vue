<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { SparklesIcon } from '@coolicons/vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import UiModal from '@owlat/ui/components/ui/Modal.vue';
import type { DataVariableExampleValue } from '@owlat/shared/dataVariableExamples';
import VariablePlaceholderTag from '../ui/VariablePlaceholderTag.vue';
import VariableExampleField from './VariableExampleField.vue';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';
import { DEFAULT_ITEM_ALIAS } from '../../utils/blockRepeat';

const { t } = useBuilderI18n();

type DataVariableType = 'string' | 'number' | 'boolean' | 'date' | 'array';

const props = defineProps<{
	show: boolean;
	existingKeys: string[];
	/** Key to start from, e.g. an undefined `{{token}}` the subject references. */
	initialKey?: string;
}>();

const emit = defineEmits<{
	(e: 'close'): void;
	(
		e: 'create',
		variable: { key: string; type: DataVariableType; example?: DataVariableExampleValue }
	): void;
}>();

/** How a repeated block reads an entry's field, with the default item alias. */
const ITEM_FIELD_EXAMPLE = `{{${DEFAULT_ITEM_ALIAS}.field}}`;

const variableKey = ref('');
const variableType = ref<DataVariableType>('string');
const example = ref<DataVariableExampleValue | undefined | 'invalid'>(undefined);
// A new field per form, so a reopened dialog starts without the last example.
const formKey = ref(0);

const normalizedKey = computed(() => variableKey.value.trim());
const isValidKey = computed(() => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(normalizedKey.value));
const isDuplicate = computed(() => props.existingKeys.includes(normalizedKey.value));
const canCreate = computed(
	() =>
		!!normalizedKey.value && isValidKey.value && !isDuplicate.value && example.value !== 'invalid'
);

const resetForm = () => {
	variableKey.value = '';
	variableType.value = 'string';
	example.value = undefined;
	formKey.value++;
};

const handleClose = () => {
	resetForm();
	emit('close');
};

const handleCreate = () => {
	if (!canCreate.value) return;
	const value = example.value === 'invalid' ? undefined : example.value;
	emit('create', {
		key: normalizedKey.value,
		type: variableType.value,
		...(value !== undefined ? { example: value } : {}),
	});
	resetForm();
};

watch(
	() => props.show,
	(isOpen) => {
		if (!isOpen) resetForm();
		else if (props.initialKey) variableKey.value = props.initialKey;
	}
);
</script>

<template>
	<UiModal
		color-scheme="light"
		:open="show"
		:title="t('builder.variableDialog.title')"
		@update:open="handleClose"
	>
		<div class="space-y-4">
			<div>
				<label class="block text-sm font-medium text-text-secondary mb-2" for="variable-name">{{
					t('builder.variableDialog.name')
				}}</label>
				<input
					id="variable-name"
					v-model="variableKey"
					type="text"
					class="input"
					:class="{ 'input-error': normalizedKey && !isValidKey }"
					placeholder="order_id"
					:aria-invalid="normalizedKey && !isValidKey ? true : undefined"
					:aria-describedby="
						normalizedKey && !isValidKey
							? 'variable-name-error'
							: isDuplicate
								? 'variable-name-duplicate'
								: undefined
					"
					@keyup.enter="handleCreate"
				/>
				<p
					v-if="normalizedKey && !isValidKey"
					id="variable-name-error"
					class="text-xs text-error mt-2"
				>
					{{ t('builder.variableDialog.invalid') }}
				</p>
				<p v-else-if="isDuplicate" id="variable-name-duplicate" class="text-xs text-warning mt-2">
					{{ t('builder.variableDialog.duplicate') }}
				</p>
			</div>

			<div>
				<label class="block text-sm font-medium text-text-secondary mb-2" for="variable-type">{{
					t('builder.variableDialog.type')
				}}</label>
				<select id="variable-type" v-model="variableType" class="input">
					<option value="string">{{ t('builder.variableDialog.types.string') }}</option>
					<option value="number">{{ t('builder.variableDialog.types.number') }}</option>
					<option value="boolean">{{ t('builder.variableDialog.types.boolean') }}</option>
					<option value="date">{{ t('builder.variableDialog.types.date') }}</option>
					<option value="array">{{ t('builder.variableDialog.types.array') }}</option>
				</select>
				<p v-if="variableType === 'array'" class="text-xs text-text-tertiary mt-2">
					{{ t('builder.variableDialog.arrayHint', { example: ITEM_FIELD_EXAMPLE }) }}
				</p>
			</div>

			<div>
				<label class="block text-sm font-medium text-text-secondary mb-2" for="variable-example">{{
					t('builder.variableDialog.example')
				}}</label>
				<VariableExampleField
					:key="formKey"
					:type="variableType"
					input-id="variable-example"
					@change="example = $event"
				/>
			</div>

			<div
				class="flex items-center justify-between rounded-lg border border-border-subtle bg-bg-surface px-3 py-2"
			>
				<div>
					<p class="text-xs text-text-tertiary">{{ t('builder.variableDialog.preview') }}</p>
					<p class="text-sm text-text-primary mt-1">{{ t('builder.variableDialog.usage') }}</p>
				</div>
				<VariablePlaceholderTag :label="normalizedKey || 'variable'" />
			</div>
		</div>

		<template #footer>
			<UiButton variant="secondary" @click="handleClose">
				{{ t('builder.common.cancel') }}
			</UiButton>
			<UiButton variant="primary" :disabled="!canCreate" @click="handleCreate">
				<template #iconLeft>
					<SparklesIcon class="w-4 h-4" />
				</template>
				{{ t('builder.variableDialog.create') }}
			</UiButton>
		</template>
	</UiModal>
</template>
