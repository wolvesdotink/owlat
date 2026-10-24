<script setup lang="ts">
type ResizeOption = 'none' | 'vertical' | 'both';
type TextareaSize = 'sm' | 'md';

interface Props {
	modelValue?: string;
	rows?: number;
	placeholder?: string;
	disabled?: boolean;
	error?: string;
	label?: string;
	required?: boolean;
	maxLength?: number;
	resize?: ResizeOption;
	id?: string;
	size?: TextareaSize;
}

const props = withDefaults(defineProps<Props>(), {
	modelValue: '',
	rows: 4,
	disabled: false,
	required: false,
	resize: 'none',
	size: 'md',
});

const emit = defineEmits<{
	'update:modelValue': [value: string];
}>();

const generatedId = useId();
const textareaId = computed(() => props.id || generatedId);

// The look is the shared `.input` recipe (assets/css/components.css), the same
// one a native field carries; this component adds only its modifiers.
const textareaClasses = computed(() => {
	const classes = ['input'];

	if (props.size === 'sm') classes.push('input-sm');
	if (props.error) classes.push('input-error');

	// Resize classes
	switch (props.resize) {
		case 'none':
			classes.push('resize-none');
			break;
		case 'vertical':
			classes.push('resize-y');
			break;
		case 'both':
			classes.push('resize');
			break;
	}

	return classes.join(' ');
});

const characterCount = computed(() => props.modelValue?.length ?? 0);

const handleInput = (event: Event) => {
	const target = event.target as HTMLTextAreaElement;
	emit('update:modelValue', target.value);
};
</script>

<template>
	<div>
		<!-- Label row with optional character count -->
		<div v-if="label || maxLength" class="flex items-center justify-between mb-2">
			<label v-if="label" :for="textareaId" class="block text-sm font-medium text-text-secondary">
				{{ label }}
				<span v-if="required" class="text-error">*</span>
			</label>
			<span v-if="maxLength" class="text-xs text-text-tertiary">
				{{ characterCount }}/{{ maxLength }}
			</span>
		</div>

		<!-- Textarea element -->
		<textarea
			:id="textareaId"
			:value="modelValue"
			:rows="rows"
			:placeholder="placeholder"
			:disabled="disabled"
			:maxlength="maxLength"
			:class="textareaClasses"
			@input="handleInput"
		/>

		<!-- Error message -->
		<p v-if="error" class="text-sm text-error mt-1">{{ error }}</p>
	</div>
</template>
