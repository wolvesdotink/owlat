<script setup lang="ts">
/**
 * Single-select option chips + a free-text input for an agent task question.
 *
 * Kills the old ambiguity between the two input modes:
 *   - picking a chip DESELECTS every other chip and CLEARS the free text;
 *   - typing in the free text visually DESELECTS the chips;
 *   - tapping the selected chip again deselects it (toggle).
 * The effective answer (`modelValue`) is always exactly one of the two.
 *
 * Chips are numbered so the shared card keyboard (1–9 picks a chip) has a
 * visible affordance; the parent card resolves the key and calls the exposed
 * `pickIndex`. Enter inside the free text emits `submit`.
 */
const props = withDefaults(
	defineProps<{
		/** The one-tap answer chips (multiple choice). May be empty (free text only). */
		options?: string[];
		/** The effective answer (chip value or free text) — v-model. */
		modelValue?: string;
		placeholder?: string;
		disabled?: boolean;
		/** data-testid overrides so refactored consumers keep their contract. */
		chipTestId?: string;
		inputTestId?: string;
	}>(),
	{
		options: () => [],
		modelValue: '',
		placeholder: undefined,
		disabled: false,
		chipTestId: 'task-option-chip',
		inputTestId: 'task-option-input',
	}
);

const emit = defineEmits<{
	(e: 'update:modelValue', value: string): void;
	(e: 'submit'): void;
}>();

// Which input mode produced the current value. Initialized from the incoming
// modelValue (an external value matching a chip counts as a chip pick), then
// owned by user interaction.
const selectedChip = ref<string | null>(
	props.options.includes(props.modelValue) && props.modelValue !== '' ? props.modelValue : null
);
const text = ref(selectedChip.value === null ? props.modelValue : '');

// External reset (parent clears the value after submit) drops both modes.
watch(
	() => props.modelValue,
	(value) => {
		if (value === (selectedChip.value ?? text.value)) return;
		selectedChip.value = props.options.includes(value) && value !== '' ? value : null;
		text.value = selectedChip.value === null ? value : '';
	}
);

function pick(option: string) {
	if (props.disabled) return;
	// Tapping the already-selected chip clears it (toggle); picking clears the text.
	selectedChip.value = selectedChip.value === option ? null : option;
	text.value = '';
	emit('update:modelValue', selectedChip.value ?? '');
}

/** Keyboard path: the parent card maps 1–9 to this. */
function pickIndex(index: number) {
	const option = props.options[index];
	if (option !== undefined) pick(option);
}

function onTextInput(event: Event) {
	// Typing is the free-text mode — visually deselect the chips.
	selectedChip.value = null;
	text.value = (event.target as HTMLInputElement).value;
	emit('update:modelValue', text.value);
}

defineExpose({ pickIndex });
</script>

<template>
	<div data-testid="task-options">
		<div v-if="options.length > 0" class="flex flex-wrap gap-1.5">
			<button
				v-for="(option, i) in options"
				:key="option"
				type="button"
				:data-testid="chipTestId"
				:aria-pressed="selectedChip === option"
				:disabled="disabled"
				class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full border transition-colors duration-(--motion-fast) disabled:opacity-50"
				:class="
					selectedChip === option
						? 'bg-brand text-white border-brand'
						: 'border-border-subtle text-text-secondary hover:bg-bg-elevated'
				"
				@click.stop="pick(option)"
			>
				<kbd v-if="i < 9" class="font-mono text-[9px] leading-none opacity-60" aria-hidden="true">{{
					i + 1
				}}</kbd>
				{{ option }}
			</button>
		</div>
		<input
			:value="text"
			type="text"
			:data-testid="inputTestId"
			:disabled="disabled"
			:placeholder="
				placeholder ?? (options.length > 0 ? 'Or type an answer…' : 'Type your answer…')
			"
			class="w-full text-sm px-2 py-1.5 rounded border border-border-subtle bg-bg-surface focus:outline-none focus:ring-1 focus:ring-brand/40"
			:class="options.length > 0 ? 'mt-1.5' : ''"
			@input="onTextInput"
			@keydown.enter.stop.prevent="emit('submit')"
			@click.stop
		/>
	</div>
</template>
