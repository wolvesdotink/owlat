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
 * The affordance is spelled out: a lead-in line says the chips are answers you
 * click, the picked chip carries a check mark, and a confirmation line under
 * the row reads back the answer that will be submitted, so nobody is left
 * wondering whether a click "took".
 *
 * `remembered` marks the chip Owlat pre-picked from the person's own earlier
 * answer to the same question (answer-memory). It is still just a selection:
 * any other chip, or typing, replaces it. The parent seeds `modelValue` with
 * that value; this component only labels it.
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
		/** The option (or free-text value) pre-picked from the person's earlier answer. */
		remembered?: string;
		/** data-testid overrides so refactored consumers keep their contract. */
		chipTestId?: string;
		inputTestId?: string;
	}>(),
	{
		options: () => [],
		modelValue: '',
		placeholder: undefined,
		disabled: false,
		remembered: undefined,
		chipTestId: 'task-option-chip',
		inputTestId: 'task-option-input',
	}
);

const emit = defineEmits<{
	(e: 'update:modelValue', value: string): void;
	(e: 'submit'): void;
}>();

const { t } = useI18n();

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

/** The answer that will be submitted, for the read-back line. */
const effectiveAnswer = computed(() => selectedChip.value ?? text.value.trim());
const isRememberedAnswer = computed(
	() => props.remembered !== undefined && effectiveAnswer.value === props.remembered
);

defineExpose({ pickIndex });
</script>

<template>
	<div data-testid="task-options">
		<template v-if="options.length > 0">
			<p class="text-[11px] text-text-tertiary mb-1" data-testid="task-options-lead">
				{{ t('components.agentTasks.taskOptions.lead') }}
			</p>
			<div class="flex flex-wrap gap-1.5" role="group">
				<button
					v-for="(option, i) in options"
					:key="option"
					type="button"
					:data-testid="chipTestId"
					:aria-pressed="selectedChip === option"
					:disabled="disabled"
					class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full border cursor-pointer transition-colors duration-(--motion-fast) disabled:opacity-50"
					:class="
						selectedChip === option
							? 'bg-text-primary text-text-inverse border-text-primary'
							: 'border-border-subtle text-text-secondary hover:bg-bg-elevated hover:border-text-tertiary'
					"
					@click.stop="pick(option)"
				>
					<Icon
						v-if="selectedChip === option"
						name="lucide:check"
						class="w-3 h-3"
						aria-hidden="true"
					/>
					<kbd
						v-else-if="i < 9"
						class="font-mono text-2xs leading-none opacity-60"
						aria-hidden="true"
						>{{ i + 1 }}</kbd
					>
					{{ option }}
					<span
						v-if="remembered !== undefined && option === remembered"
						class="ml-1 rounded-full bg-bg-elevated/20 px-1.5 py-px text-2xs font-medium uppercase tracking-[0.08em] opacity-80"
						data-testid="task-option-remembered"
						>{{ t('components.agentTasks.taskOptions.rememberedTag') }}</span
					>
				</button>
			</div>
		</template>
		<input
			:value="text"
			type="text"
			:data-testid="inputTestId"
			:disabled="disabled"
			:placeholder="
				placeholder ??
				(options.length > 0
					? t('components.agentTasks.taskOptions.orTypeAnswerPlaceholder')
					: t('components.agentTasks.taskOptions.typeAnswerPlaceholder'))
			"
			class="input input-sm"
			:class="options.length > 0 ? 'mt-1.5' : ''"
			@input="onTextInput"
			@keydown.enter.stop.prevent="emit('submit')"
			@click.stop
		/>
		<p
			v-if="effectiveAnswer.length > 0"
			class="mt-1 text-[11px] text-text-secondary"
			data-testid="task-options-readback"
		>
			<Icon
				name="lucide:check-circle-2"
				class="w-3 h-3 inline-block align-[-2px] mr-0.5 text-success"
				aria-hidden="true"
			/>
			{{
				isRememberedAnswer
					? t('components.agentTasks.taskOptions.readbackRemembered', { answer: effectiveAnswer })
					: t('components.agentTasks.taskOptions.readback', { answer: effectiveAnswer })
			}}
		</p>
	</div>
</template>
