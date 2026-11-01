<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { SparklesIcon } from '@coolicons/vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import UiModal from '@owlat/ui/components/ui/Modal.vue';
import VariablePlaceholderTag from '../ui/VariablePlaceholderTag.vue';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

type DataVariableType = 'string' | 'number' | 'boolean' | 'date';

const props = defineProps<{
	show: boolean;
	existingKeys: string[];
	/** Key to start from, e.g. an undefined `{{token}}` the subject references. */
	initialKey?: string;
}>();

const emit = defineEmits<{
	(e: 'close'): void;
	(e: 'create', variable: { key: string; type: DataVariableType }): void;
}>();

const variableKey = ref('');
const variableType = ref<DataVariableType>('string');

const normalizedKey = computed(() => variableKey.value.trim());
const isValidKey = computed(() => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(normalizedKey.value));
const isDuplicate = computed(() => props.existingKeys.includes(normalizedKey.value));
const canCreate = computed(() => !!normalizedKey.value && isValidKey.value && !isDuplicate.value);

const resetForm = () => {
	variableKey.value = '';
	variableType.value = 'string';
};

const handleClose = () => {
	resetForm();
	emit('close');
};

const handleCreate = () => {
	if (!canCreate.value) return;
	emit('create', { key: normalizedKey.value, type: variableType.value });
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
	<UiModal :open="show" :title="t('builder.variableDialog.title')" @update:open="handleClose">
		<div class="space-y-4">
			<div>
				<label class="block text-sm font-medium text-text-secondary mb-2" for="variable-name">{{
					t('builder.variableDialog.name')
				}}</label>
				<input
					id="variable-name"
					v-model="variableKey"
					type="text"
					class="w-full px-4 py-3 bg-white/[0.04] border border-border-subtle rounded-lg text-text-primary outline-none transition-[border-color,box-shadow] duration-(--motion-fast) focus:border-brand focus:ring-1 focus:ring-brand"
					placeholder="order_id"
					@keyup.enter="handleCreate"
				/>
				<p v-if="normalizedKey && !isValidKey" class="text-xs text-error mt-2">
					{{ t('builder.variableDialog.invalid') }}
				</p>
				<p v-else-if="isDuplicate" class="text-xs text-warning mt-2">
					{{ t('builder.variableDialog.duplicate') }}
				</p>
			</div>

			<div>
				<label class="block text-sm font-medium text-text-secondary mb-2" for="variable-type">{{
					t('builder.variableDialog.type')
				}}</label>
				<select
					id="variable-type"
					v-model="variableType"
					class="w-full px-4 py-3 bg-white/[0.04] border border-border-subtle rounded-lg text-text-primary outline-none transition-[border-color,box-shadow] duration-(--motion-fast) focus:border-brand"
				>
					<option value="string">{{ t('builder.variableDialog.types.string') }}</option>
					<option value="number">{{ t('builder.variableDialog.types.number') }}</option>
					<option value="boolean">{{ t('builder.variableDialog.types.boolean') }}</option>
					<option value="date">{{ t('builder.variableDialog.types.date') }}</option>
				</select>
			</div>

			<div
				class="flex items-center justify-between rounded-lg border border-border-subtle bg-white/[0.03] px-3 py-2"
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
