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

const textareaClasses = computed(() => {
	const classes = [
		'w-full bg-surface-1 shadow-surface-1 rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-brand transition-[box-shadow,background-color] duration-(--motion-fast) ease-spring',
	];

	if (props.size === 'sm') {
		classes.push('px-3 py-2 text-sm');
	} else {
		classes.push('px-4 py-3');
	}

	if (props.error) {
		classes.push('ring-1 ring-error focus:ring-error');
	}

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
