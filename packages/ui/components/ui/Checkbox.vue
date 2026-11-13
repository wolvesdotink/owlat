<script setup lang="ts">
interface Props {
	modelValue?: boolean;
	/** Some but not all of a group is checked; read out as "mixed". */
	indeterminate?: boolean;
	disabled?: boolean;
	label?: string;
	/** Names the box when there is no visible `label` (e.g. a table row's selection). */
	ariaLabel?: string;
	description?: string;
	id?: string;
}

const props = withDefaults(defineProps<Props>(), {
	modelValue: false,
	indeterminate: false,
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
		:class="{
			'opacity-50 cursor-not-allowed': disabled,
			// A bare box is a 16px target; on touch the label around it grows to 44px.
			'pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center pointer-coarse:justify-center':
				!label && !description,
		}"
	>
		<!-- Checkbox input -->
		<input
			:id="checkboxId"
			type="checkbox"
			:checked="modelValue"
			:indeterminate="indeterminate"
			:disabled="disabled"
			:aria-label="ariaLabel"
			class="mt-1 h-4 w-4 shrink-0 accent-brand focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2"
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
