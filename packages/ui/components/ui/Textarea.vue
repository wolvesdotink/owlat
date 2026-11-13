<script setup lang="ts">
import { useAttrs, type TextareaHTMLAttributes } from 'vue';

/*
 * Attribute contract, as UiInput: `class` and `style` go on the root
 * container; every other attribute and listener (name, aria-*, data-*,
 * @keydown, …) goes on the native <textarea>. The ARIA state derived from
 * `error`/`required` wins when set; a caller's aria-describedby is joined with
 * the error and counter ids.
 */
defineOptions({ inheritAttrs: false });

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

const attrs = useAttrs();

const containerAttrs = () => ({ class: attrs.class, style: attrs.style });

const nativeAttrs = () => {
	const { class: _class, style: _style, ...native } = attrs;
	return native;
};

const ariaInvalid = () =>
	(props.error ? true : attrs['aria-invalid']) as TextareaHTMLAttributes['aria-invalid'];

const ariaRequired = () =>
	(props.required ? true : attrs['aria-required']) as TextareaHTMLAttributes['aria-required'];

const describedBy = () => {
	const ids: string[] = [];
	const callerIds = attrs['aria-describedby'];
	if (typeof callerIds === 'string' && callerIds.trim()) ids.push(callerIds.trim());
	if (props.error) ids.push(`${textareaId.value}-error`);
	if (props.maxLength) ids.push(`${textareaId.value}-count`);
	return ids.length ? ids.join(' ') : undefined;
};

const characterCount = computed(() => props.modelValue?.length ?? 0);

const handleInput = (event: Event) => {
	const target = event.target as HTMLTextAreaElement;
	emit('update:modelValue', target.value);
};
</script>

<template>
	<div v-bind="containerAttrs()">
		<!-- Label row with optional character count -->
		<div v-if="label || maxLength" class="flex items-center justify-between mb-2">
			<label v-if="label" :for="textareaId" class="block text-sm font-medium text-text-secondary">
				{{ label }}
				<span v-if="required" class="text-error" aria-hidden="true">*</span>
			</label>
			<span v-if="maxLength" :id="`${textareaId}-count`" class="text-xs text-text-tertiary">
				{{ characterCount }}/{{ maxLength }}
			</span>
		</div>

		<!-- Textarea element -->
		<textarea
			v-bind="nativeAttrs()"
			:id="textareaId"
			:value="modelValue"
			:rows="rows"
			:placeholder="placeholder"
			:disabled="disabled"
			:maxlength="maxLength"
			:class="textareaClasses"
			:required="required"
			:aria-required="ariaRequired()"
			:aria-invalid="ariaInvalid()"
			:aria-describedby="describedBy()"
			@input="handleInput"
		/>

		<!-- Error message -->
		<p v-if="error" :id="`${textareaId}-error`" class="text-sm text-error mt-1">{{ error }}</p>
	</div>
</template>
