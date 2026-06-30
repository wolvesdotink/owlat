<script setup lang="ts">
interface Props {
	label: string;
	description?: string;
	type?: 'radio' | 'checkbox';
	modelValue: string | boolean | string[];
	value?: string;
	name?: string;
	disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	type: 'radio',
	disabled: false,
});

const emit = defineEmits<{
	'update:modelValue': [value: string | boolean | string[]];
}>();

const inputId = `selectable-item-${Math.random().toString(36).slice(2, 9)}`;

const isChecked = computed(() => {
	if (props.type === 'checkbox') {
		if (Array.isArray(props.modelValue)) {
			return props.value ? props.modelValue.includes(props.value) : false;
		}
		return Boolean(props.modelValue);
	}
	return props.modelValue === props.value;
});

const handleChange = (event: Event) => {
	const target = event.target as HTMLInputElement;

	if (props.type === 'checkbox') {
		if (Array.isArray(props.modelValue) && props.value) {
			const newValue = target.checked
				? [...props.modelValue, props.value]
				: props.modelValue.filter((v) => v !== props.value);
			emit('update:modelValue', newValue);
		} else {
			emit('update:modelValue', target.checked);
		}
	} else {
		if (props.value !== undefined) {
			emit('update:modelValue', props.value);
		}
	}
};
</script>

<template>
	<label
		:for="inputId"
		:class="[
			'flex items-start gap-3 p-3 rounded-lg bg-bg-surface cursor-pointer transition-colors',
			disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-bg-surface/80',
		]"
	>
		<input
			:id="inputId"
			:type="type"
			:name="name"
			:value="value"
			:checked="isChecked"
			:disabled="disabled"
			class="w-4 h-4 mt-0.5 text-brand border-border-subtle bg-bg-surface focus:ring-brand"
			@change="handleChange"
		/>
		<div class="flex-1 min-w-0">
			<p class="text-sm font-medium text-text-primary">{{ label }}</p>
			<p v-if="description" class="text-xs text-text-tertiary">{{ description }}</p>
		</div>
	</label>
</template>
