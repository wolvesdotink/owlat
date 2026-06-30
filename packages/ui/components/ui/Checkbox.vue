<script setup lang="ts">
interface Props {
	modelValue?: boolean;
	disabled?: boolean;
	label?: string;
	description?: string;
	id?: string;
}

const props = withDefaults(defineProps<Props>(), {
	modelValue: false,
	disabled: false,
});

const emit = defineEmits<{
	'update:modelValue': [value: boolean];
}>();

const generatedId = useId();
const checkboxId = computed(() => props.id || generatedId);

const handleChange = (event: Event) => {
	const target = event.target as HTMLInputElement;
	emit('update:modelValue', target.checked);
};
</script>

<template>
	<label
		:for="checkboxId"
		class="flex items-start gap-3 cursor-pointer"
		:class="{ 'opacity-50 cursor-not-allowed': disabled }"
	>
		<!-- Checkbox input -->
		<input
			:id="checkboxId"
			type="checkbox"
			:checked="modelValue"
			:disabled="disabled"
			class="mt-1 h-4 w-4 rounded border-border-default bg-bg-deep text-brand focus:ring-brand focus:ring-offset-0"
			@change="handleChange"
		/>

		<!-- Label and description -->
		<div v-if="label || description" class="flex-1">
			<span v-if="label" class="text-sm font-medium text-text-primary">
				{{ label }}
			</span>
			<p v-if="description" class="text-sm text-text-tertiary">
				{{ description }}
			</p>
		</div>
	</label>
</template>
