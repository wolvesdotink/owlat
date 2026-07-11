<script setup lang="ts">
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

	if (hasIconLeft.value) {
		classes.push(props.size === 'sm' ? 'pl-8' : 'pl-10');
	}

	if (hasIconRight.value) {
		classes.push(props.size === 'sm' ? 'pr-8' : 'pr-10');
	}

	return classes.join(' ');
});

// Error/help text is announced with the field, not just rendered near it.
const describedBy = computed(() => {
	const ids: string[] = [];
	if (props.error) ids.push(`${inputId.value}-error`);
	if (props.helpText) ids.push(`${inputId.value}-help`);
	return ids.length ? ids.join(' ') : undefined;
});

const handleInput = (event: Event) => {
	const target = event.target as HTMLInputElement;
	const value = props.type === 'number' ? Number(target.value) : target.value;
	emit('update:modelValue', value);
};
</script>

<template>
	<div>
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
				:id="inputId"
				ref="inputRef"
				:type="type"
				:value="modelValue"
				:placeholder="placeholder"
				:disabled="disabled"
				:autocomplete="autocomplete"
				:class="inputClasses"
				:required="required"
				:aria-required="required || undefined"
				:aria-invalid="error ? true : undefined"
				:aria-describedby="describedBy"
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
