<script setup lang="ts" generic="T extends string | number">
import { useUiI18n } from '../../composables/useUiI18n';

type SelectSize = 'sm' | 'md';

interface SelectOption<V = T> {
	value: V;
	label: string;
}

interface Props {
	options: SelectOption<T>[];
	modelValue?: T | null;
	/** Defaults to the localized "Select an option". */
	placeholder?: string;
	disabled?: boolean;
	error?: string;
	label?: string;
	required?: boolean;
	id?: string;
	size?: SelectSize;
	/**
	 * Accessible name for a select without a visible `label`. Without either (and
	 * without an `id` an outside `<label for>` points at), the placeholder names it.
	 */
	ariaLabel?: string;
}

// `placeholder` has no default: prop defaults are evaluated outside the setup
// context, where `useUiI18n()` cannot run. It is resolved below instead.
const props = withDefaults(defineProps<Props>(), {
	modelValue: null,
	placeholder: undefined,
	disabled: false,
	required: false,
	size: 'md',
	ariaLabel: undefined,
});

const { t } = useUiI18n();

const emit = defineEmits<{
	'update:modelValue': [value: T | null];
}>();

const isOpen = ref(false);
/** The option the keyboard is on while open (`aria-activedescendant`). */
const activeIndex = ref(-1);
const triggerRef = ref<HTMLElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);

const generatedId = useId();
const selectId = computed(() => props.id || generatedId);
const labelId = computed(() => `${selectId.value}-label`);
const listboxId = computed(() => `${selectId.value}-listbox`);
const errorId = computed(() => `${selectId.value}-error`);
const optionId = (index: number) => `${selectId.value}-option-${index}`;

const selectedIndex = computed(() => {
	if (props.modelValue === null || props.modelValue === undefined) return -1;
	return props.options.findIndex((opt) => opt.value === props.modelValue);
});

const selectedOption = computed(() => props.options[selectedIndex.value] ?? null);

const placeholderText = computed(() => props.placeholder || t('ui.select.placeholder'));

const displayText = computed(() => selectedOption.value?.label || placeholderText.value);

// The visible label (or an outside `<label for>` when the caller passes `id`)
// names the trigger; the combobox role does not take its name from its text.
const triggerAriaLabel = computed(
	() => props.ariaLabel ?? (props.label || props.id ? undefined : placeholderText.value)
);

const activeDescendant = computed(() =>
	isOpen.value && activeIndex.value >= 0 ? optionId(activeIndex.value) : undefined
);

const triggerClasses = computed(() => {
	const classes = [
		'ui-select-control w-full flex items-center justify-between gap-2 text-left',
		'bg-surface-1 rounded-lg transition-[box-shadow,background-color] duration-(--motion-fast) ease-spring',
		'focus:outline-none focus:ring-1 focus:ring-brand',
	];

	if (props.size === 'sm') {
		classes.push('min-h-8 px-3 py-1.5 text-sm leading-5');
	} else {
		classes.push('min-h-9 px-3 py-2 text-sm leading-5');
	}

	if (props.error) {
		classes.push('shadow-surface-1 ring-1 ring-error focus:ring-error');
	} else if (isOpen.value) {
		classes.push('ring-1 ring-brand');
	} else {
		classes.push('shadow-surface-1');
	}

	if (props.disabled) {
		classes.push('opacity-50 cursor-not-allowed');
	} else {
		classes.push('cursor-pointer hover:shadow-surface-2');
	}

	return classes.join(' ');
});

const textClasses = computed(() => {
	if (selectedOption.value) {
		return 'text-text-primary';
	}
	return 'text-text-tertiary';
});

const lastIndex = () => props.options.length - 1;

const open = (index?: number) => {
	if (props.disabled || props.options.length === 0) return;
	activeIndex.value = index ?? Math.max(selectedIndex.value, 0);
	isOpen.value = true;
};

/**
 * Focus stays on the trigger while the list is open, so a keyboard close keeps
 * the user's place. An outside click passes `false`: focus belongs to whatever
 * the user clicked.
 */
const close = (restoreFocus: boolean) => {
	isOpen.value = false;
	resetTypeahead();
	if (restoreFocus) triggerRef.value?.focus();
};

const toggle = () => {
	if (props.disabled) return;
	if (isOpen.value) close(true);
	else open();
};

const selectOption = (option: SelectOption<T>) => {
	emit('update:modelValue', option.value);
	close(true);
};

const selectActive = () => {
	const option = props.options[activeIndex.value];
	if (option) selectOption(option);
	else close(true);
};

// Typeahead: typed characters jump to the next option whose label starts with
// them; repeating one character cycles through the options it starts.
const TYPEAHEAD_RESET_MS = 500;
let typeaheadBuffer = '';
let typeaheadTimer: ReturnType<typeof setTimeout> | undefined;

function resetTypeahead() {
	typeaheadBuffer = '';
	clearTimeout(typeaheadTimer);
}

const typeahead = (char: string) => {
	clearTimeout(typeaheadTimer);
	typeaheadTimer = setTimeout(resetTypeahead, TYPEAHEAD_RESET_MS);
	typeaheadBuffer += char.toLowerCase();
	const repeated = [...typeaheadBuffer].every((c) => c === typeaheadBuffer[0]);
	const query = repeated ? typeaheadBuffer[0]! : typeaheadBuffer;
	const count = props.options.length;
	const start = activeIndex.value + (repeated ? 1 : 0);
	for (let step = 0; step < count; step++) {
		const index = (((start + step) % count) + count) % count;
		if (props.options[index]!.label.trim().toLowerCase().startsWith(query)) {
			activeIndex.value = index;
			return;
		}
	}
};

const isTypeaheadKey = (event: KeyboardEvent) =>
	event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;

const PAGE_STEP = 10;

const handleTriggerKeydown = (event: KeyboardEvent) => {
	if (props.disabled) return;
	const { key } = event;

	if (!isOpen.value) {
		if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
			event.preventDefault();
			open();
		} else if (key === 'Home') {
			event.preventDefault();
			open(0);
		} else if (key === 'End') {
			event.preventDefault();
			open(lastIndex());
		} else if (isTypeaheadKey(event)) {
			event.preventDefault();
			open();
			typeahead(key);
		}
		return;
	}

	switch (key) {
		case 'ArrowDown':
			event.preventDefault();
			activeIndex.value = Math.min(activeIndex.value + 1, lastIndex());
			return;
		case 'ArrowUp':
			event.preventDefault();
			if (event.altKey) selectActive();
			else activeIndex.value = Math.max(activeIndex.value - 1, 0);
			return;
		case 'Home':
			event.preventDefault();
			activeIndex.value = 0;
			return;
		case 'End':
			event.preventDefault();
			activeIndex.value = lastIndex();
			return;
		case 'PageDown':
			event.preventDefault();
			activeIndex.value = Math.min(activeIndex.value + PAGE_STEP, lastIndex());
			return;
		case 'PageUp':
			event.preventDefault();
			activeIndex.value = Math.max(activeIndex.value - PAGE_STEP, 0);
			return;
		case 'Enter':
			event.preventDefault();
			selectActive();
			return;
		case 'Tab':
			// Leaving does not commit what the arrows only passed over.
			close(false);
			return;
	}

	if (key === ' ' && !typeaheadBuffer) {
		event.preventDefault();
		selectActive();
	} else if (isTypeaheadKey(event)) {
		event.preventDefault();
		typeahead(key);
	}
};

// A button activates on the Space keyup in some engines even when the keydown
// was handled, which would toggle the list straight back.
const handleTriggerKeyup = (event: KeyboardEvent) => {
	if (event.key === ' ') event.preventDefault();
};

/**
 * Escape is taken in the window's capture phase: a surrounding modal listens on
 * the document in capture, and closing the list must not close the dialog too.
 */
const handleEscape = (event: KeyboardEvent) => {
	if (event.key !== 'Escape' || !isOpen.value) return;
	event.preventDefault();
	event.stopPropagation();
	close(true);
};

const handleClickOutside = (event: MouseEvent) => {
	const target = event.target as HTMLElement;
	if (
		menuRef.value &&
		!menuRef.value.contains(target) &&
		triggerRef.value &&
		!triggerRef.value.contains(target)
	) {
		close(false);
	}
};

const removeListeners = () => {
	document.removeEventListener('click', handleClickOutside);
	window.removeEventListener('keydown', handleEscape, true);
};

watch(isOpen, (isNowOpen) => {
	if (isNowOpen) {
		document.addEventListener('click', handleClickOutside);
		window.addEventListener('keydown', handleEscape, true);
	} else {
		removeListeners();
	}
});

// Keep the active option in view on open and as the keyboard walks a long list.
watch([isOpen, activeIndex], async ([isNowOpen, index]) => {
	if (!isNowOpen || index < 0) return;
	await nextTick();
	const option = menuRef.value?.children[index] as HTMLElement | undefined;
	option?.scrollIntoView?.({ block: 'nearest' });
});

watch(
	() => props.disabled,
	(disabled) => {
		if (disabled && isOpen.value) close(false);
	}
);

watch(
	() => props.options.length,
	(length) => {
		if (length === 0) close(false);
		else if (activeIndex.value > length - 1) activeIndex.value = length - 1;
	}
);

onUnmounted(() => {
	removeListeners();
	clearTimeout(typeaheadTimer);
});
</script>

<template>
	<div>
		<!-- Label -->
		<label
			v-if="label"
			:id="labelId"
			:for="selectId"
			class="block text-sm font-medium text-text-secondary mb-2"
		>
			{{ label }}
			<span v-if="required" class="text-error">*</span>
		</label>

		<!-- Select trigger: a select-only combobox; focus stays here while open -->
		<div class="relative">
			<button
				:id="selectId"
				ref="triggerRef"
				type="button"
				role="combobox"
				aria-haspopup="listbox"
				:aria-expanded="isOpen"
				:aria-controls="isOpen ? listboxId : undefined"
				:aria-activedescendant="activeDescendant"
				:aria-label="triggerAriaLabel"
				:aria-required="required || undefined"
				:aria-invalid="error ? true : undefined"
				:aria-describedby="error ? errorId : undefined"
				:class="triggerClasses"
				:disabled="disabled"
				@click="toggle"
				@keydown="handleTriggerKeydown"
				@keyup="handleTriggerKeyup"
			>
				<span :class="textClasses" class="truncate">{{ displayText }}</span>
				<Icon
					name="lucide:chevron-down"
					class="w-4 h-4 text-text-tertiary shrink-0 transition-transform duration-(--motion-moderate) ease-spring"
					:class="{ 'rotate-180': isOpen }"
					aria-hidden="true"
				/>
			</button>

			<!-- Dropdown listbox. mousedown.prevent: clicking an option must not pull
			     focus off the trigger. -->
			<Transition
				enter-active-class="duration-(--motion-moderate) ease-spring"
				enter-from-class="opacity-0 translate-y-1"
				enter-to-class="opacity-100 translate-y-0"
				leave-active-class="duration-(--motion-moderate-exit) ease-exit"
				leave-from-class="opacity-100 translate-y-0"
				leave-to-class="opacity-0 translate-y-1"
			>
				<ul
					v-if="isOpen"
					:id="listboxId"
					ref="menuRef"
					role="listbox"
					:aria-labelledby="label && !ariaLabel ? labelId : undefined"
					:aria-label="label && !ariaLabel ? undefined : (ariaLabel ?? placeholderText)"
					class="absolute z-50 w-full mt-1 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg py-1 max-h-60 overflow-y-auto"
					@mousedown.prevent
				>
					<li
						v-for="(option, index) in options"
						:id="optionId(index)"
						:key="String(option.value)"
						role="option"
						:aria-selected="index === selectedIndex"
						class="w-full px-3 py-2 text-left text-sm flex items-center justify-between gap-2 transition-colors cursor-pointer"
						:class="[
							index === selectedIndex ? 'text-brand' : 'text-text-primary',
							index === activeIndex ? 'bg-bg-surface' : index === selectedIndex ? 'bg-brand/5' : '',
						]"
						@mouseenter="activeIndex = index"
						@click="selectOption(option)"
					>
						<span class="truncate">{{ option.label }}</span>
						<Icon
							v-if="index === selectedIndex"
							name="lucide:check"
							class="w-4 h-4 text-brand shrink-0"
							aria-hidden="true"
						/>
					</li>
				</ul>
			</Transition>
		</div>

		<!-- Error message -->
		<p v-if="error" :id="errorId" class="text-sm text-error mt-1">{{ error }}</p>
	</div>
</template>
