<script setup lang="ts" generic="T extends string | number">
type SelectSize = 'sm' | 'md';

interface SelectOption<V = T> {
	value: V;
	label: string;
}

interface Props {
	options: SelectOption<T>[];
	modelValue?: T | null;
	placeholder?: string;
	disabled?: boolean;
	error?: string;
	label?: string;
	required?: boolean;
	id?: string;
	size?: SelectSize;
}

const props = withDefaults(defineProps<Props>(), {
	modelValue: null,
	placeholder: 'Select an option',
	disabled: false,
	required: false,
	size: 'md',
});

const emit = defineEmits<{
	'update:modelValue': [value: T | null];
}>();

const isOpen = ref(false);
const triggerRef = ref<HTMLElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);

const generatedId = useId();
const selectId = computed(() => props.id || generatedId);

const selectedOption = computed(() => {
	if (props.modelValue === null || props.modelValue === undefined) return null;
	return props.options.find((opt) => opt.value === props.modelValue) || null;
});

const displayText = computed(() => {
	return selectedOption.value?.label || props.placeholder;
});

const triggerClasses = computed(() => {
	const classes = [
		'w-full flex items-center justify-between gap-2 text-left',
		'bg-bg-surface border rounded-lg transition-colors duration-150',
		'focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand',
	];

	if (props.size === 'sm') {
		classes.push('px-3 py-2 text-sm');
	} else {
		classes.push('px-4 py-3');
	}

	if (props.error) {
		classes.push('border-error focus:border-error focus:ring-error');
	} else if (isOpen.value) {
		classes.push('border-brand ring-1 ring-brand');
	} else {
		classes.push('border-border-default');
	}

	if (props.disabled) {
		classes.push('opacity-50 cursor-not-allowed');
	} else {
		classes.push('cursor-pointer hover:border-border-strong');
	}

	return classes.join(' ');
});

const textClasses = computed(() => {
	if (selectedOption.value) {
		return 'text-text-primary';
	}
	return 'text-text-tertiary';
});

const toggle = () => {
	if (props.disabled) return;
	isOpen.value = !isOpen.value;
};

const selectOption = (option: SelectOption<T>) => {
	emit('update:modelValue', option.value);
	isOpen.value = false;
};

const handleClickOutside = (event: MouseEvent) => {
	const target = event.target as HTMLElement;
	if (
		menuRef.value &&
		!menuRef.value.contains(target) &&
		triggerRef.value &&
		!triggerRef.value.contains(target)
	) {
		isOpen.value = false;
	}
};

const handleEscape = (event: KeyboardEvent) => {
	if (event.key === 'Escape' && isOpen.value) {
		isOpen.value = false;
	}
};

watch(isOpen, (open) => {
	if (open) {
		document.addEventListener('click', handleClickOutside);
		document.addEventListener('keydown', handleEscape);
	} else {
		document.removeEventListener('click', handleClickOutside);
		document.removeEventListener('keydown', handleEscape);
	}
});

onUnmounted(() => {
	document.removeEventListener('click', handleClickOutside);
	document.removeEventListener('keydown', handleEscape);
});
</script>

<template>
	<div>
		<!-- Label -->
		<label v-if="label" :for="selectId" class="block text-sm font-medium text-text-secondary mb-2">
			{{ label }}
			<span v-if="required" class="text-error">*</span>
		</label>

		<!-- Select trigger -->
		<div class="relative">
			<button
				:id="selectId"
				ref="triggerRef"
				type="button"
				:class="triggerClasses"
				:disabled="disabled"
				@click="toggle"
			>
				<span :class="textClasses" class="truncate">{{ displayText }}</span>
				<Icon
					name="lucide:chevron-down"
					class="w-4 h-4 text-text-tertiary shrink-0 transition-transform duration-150"
					:class="{ 'rotate-180': isOpen }"
				/>
			</button>

			<!-- Dropdown menu -->
			<Transition
				enter-active-class="duration-150 ease-out"
				enter-from-class="opacity-0 translate-y-1"
				enter-to-class="opacity-100 translate-y-0"
				leave-active-class="duration-100 ease-in"
				leave-from-class="opacity-100 translate-y-0"
				leave-to-class="opacity-0 translate-y-1"
			>
				<div
					v-if="isOpen"
					ref="menuRef"
					class="absolute z-50 w-full mt-1 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg py-1 max-h-60 overflow-y-auto"
				>
					<button
						v-for="option in options"
						:key="String(option.value)"
						type="button"
						class="w-full px-3 py-2 text-left text-sm flex items-center justify-between gap-2 transition-colors hover:bg-bg-surface"
						:class="[option.value === modelValue ? 'text-brand bg-brand/5' : 'text-text-primary']"
						@click="selectOption(option)"
					>
						<span class="truncate">{{ option.label }}</span>
						<Icon v-if="option.value === modelValue" name="lucide:check" class="w-4 h-4 text-brand shrink-0" />
					</button>
				</div>
			</Transition>
		</div>

		<!-- Error message -->
		<p v-if="error" class="text-sm text-error mt-1">{{ error }}</p>
	</div>
</template>
