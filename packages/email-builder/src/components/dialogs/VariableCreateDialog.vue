<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Sparkles } from '@lucide/vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import UiModal from '@owlat/ui/components/ui/Modal.vue';
import VariablePlaceholderTag from '../ui/VariablePlaceholderTag.vue';

type DataVariableType = 'string' | 'number' | 'boolean' | 'date';

const props = defineProps<{
	show: boolean;
	existingKeys: string[];
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
	}
);
</script>

<template>
	<UiModal :open="show" title="Add data variable" @update:open="handleClose">
		<div class="space-y-4">
			<div>
				<label class="block text-sm font-medium text-text-secondary mb-2">Variable name</label>
				<input
					v-model="variableKey"
					type="text"
					class="w-full px-4 py-3 bg-white/[0.04] border border-border-subtle rounded-lg text-text-primary outline-none transition-[border-color,box-shadow] duration-150 focus:border-brand focus:ring-1 focus:ring-brand"
					placeholder="order_id"
					@keyup.enter="handleCreate"
				/>
				<p v-if="normalizedKey && !isValidKey" class="text-xs text-error mt-2">
					Start with a letter and use only letters, numbers, or underscores.
				</p>
				<p v-else-if="isDuplicate" class="text-xs text-warning mt-2">
					A variable with this name already exists.
				</p>
			</div>

			<div>
				<label class="block text-sm font-medium text-text-secondary mb-2">Type</label>
				<select
					v-model="variableType"
					class="w-full px-4 py-3 bg-white/[0.04] border border-border-subtle rounded-lg text-text-primary outline-none transition-[border-color,box-shadow] duration-150 focus:border-brand"
				>
					<option value="string">String</option>
					<option value="number">Number</option>
					<option value="boolean">Boolean</option>
					<option value="date">Date</option>
				</select>
			</div>

			<div
				class="flex items-center justify-between rounded-lg border border-border-subtle bg-white/[0.03] px-3 py-2"
			>
				<div>
					<p class="text-xs text-text-tertiary">Preview</p>
					<p class="text-sm text-text-primary mt-1">Used in the API payload</p>
				</div>
				<VariablePlaceholderTag :label="normalizedKey || 'variable'" />
			</div>
		</div>

		<template #footer>
			<UiButton variant="secondary" @click="handleClose">
				Cancel
			</UiButton>
			<UiButton variant="primary" :disabled="!canCreate" @click="handleCreate">
				<template #iconLeft>
					<Sparkles class="w-4 h-4" />
				</template>
				Create variable
			</UiButton>
		</template>
	</UiModal>
</template>
