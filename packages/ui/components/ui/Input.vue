<script setup lang="ts">
import { useAttrs, type InputHTMLAttributes } from 'vue';

/*
 * Attribute contract: `class` and `style` go on the root container, so callers
 * can still place and size the field (margins, widths, flex). Every other
 * attribute and listener the caller passes (min, max, step, name, pattern,
 * maxlength, inputmode, aria-*, data-*, @keydown, @focus, …) goes on the
 * native <input>. The input's value and classes stay owned by this component.
 * The ARIA state it derives from `error`/`required` wins when set, and falls
 * back to the caller's own aria-invalid/aria-required otherwise; a caller's
 * aria-describedby is joined with the error/help text ids.
 */
defineOptions({ inheritAttrs: false });

type InputType = 'text' | 'email' | 'password' | 'number' | 'date';
type InputSize = 'sm' | 'md';

interface Props {
	type?: InputType;
	modelValue?: string | number;
	placeholder?: string;
	disabled?: boolean;
	autocomplete?: string;
	error?: string;
	label?: string;
	required?: boolean;
	helpText?: string;
	id?: string;
	size?: InputSize;
	/**
	 * Focus the field on mount. Unlike the native `autofocus` attribute this also
	 * fires on client-side route changes (SPA navigation between wizard steps),
	 * where the browser would otherwise skip autofocus.
	 */
	autofocus?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	type: 'text',
	modelValue: '',
	disabled: false,
	required: false,
	size: 'md',
	autofocus: false,
});

const inputRef = ref<HTMLInputElement | null>(null);

onMounted(() => {
	if (props.autofocus) inputRef.value?.focus();
});

const emit = defineEmits<{
	'update:modelValue': [value: string | number];
	blur: [event: FocusEvent];
}>();

const generatedId = useId();
const inputId = computed(() => props.id || generatedId);

const hasIconLeft = computed(() => !!useSlots()['iconLeft']);
const hasIconRight = computed(() => !!useSlots()['iconRight']);

const inputClasses = computed(() => {
	const classes = [
		'ui-input-control w-full bg-surface-1 shadow-surface-1 rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-brand transition-[box-shadow,background-color] duration-(--motion-fast) ease-spring',
	];

	if (props.size === 'sm') {
		classes.push('min-h-8 px-3 py-1.5 text-sm leading-5');
	} else {
		classes.push('min-h-9 px-3 py-2 text-sm leading-5');
	}

	if (props.error) {
		classes.push('ring-1 ring-error focus:ring-error');
	}

	if (hasIconLeft.value) {
		classes.push(props.size === 'sm' ? 'pl-8' : 'pl-10');
	}

	if (hasIconRight.value) {
		classes.push(props.size === 'sm' ? 'pr-8' : 'pr-10');
	}

	return classes.join(' ');
});

// `useAttrs()` is not reactive, so the readers below run during render
// rather than inside a computed that would cache the first attrs it saw.
const attrs = useAttrs();

const containerAttrs = () => ({ class: attrs.class, style: attrs.style });

const nativeAttrs = () => {
	const { class: _class, style: _style, ...native } = attrs;
	return native;
};

const ariaInvalid = () =>
	(props.error ? true : attrs['aria-invalid']) as InputHTMLAttributes['aria-invalid'];

const ariaRequired = () =>
	(props.required ? true : attrs['aria-required']) as InputHTMLAttributes['aria-required'];

// Error/help text is announced with the field, not just rendered near it.
const describedBy = () => {
	const ids: string[] = [];
	const callerIds = attrs['aria-describedby'];
	if (typeof callerIds === 'string' && callerIds.trim()) ids.push(callerIds.trim());
	if (props.error) ids.push(`${inputId.value}-error`);
	if (props.helpText) ids.push(`${inputId.value}-help`);
	return ids.length ? ids.join(' ') : undefined;
};

const handleInput = (event: Event) => {
	const target = event.target as HTMLInputElement;
	const value = props.type === 'number' ? Number(target.value) : target.value;
	emit('update:modelValue', value);
};
</script>

<template>
	<div v-bind="containerAttrs()">
		<!-- Label -->
		<label v-if="label" :for="inputId" class="block text-sm font-medium text-text-secondary mb-2">
			{{ label }}
			<span v-if="required" class="text-error">*</span>
		</label>

		<!-- Input wrapper -->
		<div class="relative">
			<!-- Left icon slot -->
			<div
				v-if="$slots['iconLeft']"
				class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary pointer-events-none"
				aria-hidden="true"
			>
				<slot name="iconLeft" />
			</div>

			<!-- Input element -->
			<input
				v-bind="nativeAttrs()"
				:id="inputId"
				ref="inputRef"
				:type="type"
				:value="modelValue"
				:placeholder="placeholder"
				:disabled="disabled"
				:autocomplete="autocomplete"
				:class="inputClasses"
				:required="required"
				:aria-required="ariaRequired()"
				:aria-invalid="ariaInvalid()"
				:aria-describedby="describedBy()"
				@input="handleInput"
				@blur="emit('blur', $event)"
			/>

			<!-- Right icon slot -->
			<div
				v-if="$slots['iconRight']"
				class="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary pointer-events-none"
				aria-hidden="true"
			>
				<slot name="iconRight" />
			</div>
		</div>

		<!-- Error message -->
		<p v-if="error" :id="`${inputId}-error`" class="text-sm text-error mt-1">{{ error }}</p>

		<!-- Help text (only shown when no error) -->
		<p v-else-if="helpText" :id="`${inputId}-help`" class="text-sm text-text-tertiary mt-1">
			{{ helpText }}
		</p>
	</div>
</template>
