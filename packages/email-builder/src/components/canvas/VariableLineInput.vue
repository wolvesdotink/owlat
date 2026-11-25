<script setup lang="ts">
/**
 * A one-line text input that takes `{{variable}}` tokens: the subject line and
 * the preview text above the canvas. Typing `{{` or pressing the insert button
 * opens the variable picker; a pick is inserted as literal token text, which
 * the send path personalizes with the same grammar as the body.
 */
import { computed, nextTick, ref, useId } from 'vue';
import { BracesIcon } from '@coolicons/vue';
import UiTooltip from '@owlat/ui/components/ui/Tooltip.vue';
import type { Variable } from '../../types';
import VariablePickerMenu from './VariablePickerMenu.vue';
import {
	findSubjectVariableTrigger,
	insertSubjectVariable,
	type SubjectRange,
} from '../../utils/subjectVariables';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

const props = defineProps<{
	id: string;
	value: string;
	variables: Variable[];
	/** The accessible name of the input. */
	fieldLabel: string;
	placeholder: string;
	insertTitle: string;
	insertLabel: string;
	testId: string;
	/** Draws the warning border; the caller renders the hint itself. */
	warn?: boolean;
	/** The id of the caller's hint, while one is shown. */
	describedBy?: string;
	maxLength?: number;
}>();

const emit = defineEmits<{
	(e: 'update:value', value: string): void;
}>();

const pickerId = useId();
const input = ref<HTMLInputElement | null>(null);
const frame = ref<HTMLElement | null>(null);

const canInsertVariables = computed(() => props.variables.length > 0);

// Picker state. `range` is the text a pick replaces: the typed `{{query` when
// opened by typing, the current selection when opened by the button.
const pickerOpen = ref(false);
const pickerQuery = ref('');
const pickerIndex = ref(0);
const pickerTop = ref(0);
let pickerRange: SubjectRange = { start: 0, end: 0 };
let pickerFromButton = false;

const filteredVariables = computed(() => {
	const q = pickerQuery.value.toLowerCase();
	return props.variables.filter(
		(v) => v.key.toLowerCase().includes(q) || v.label.toLowerCase().includes(q)
	);
});
const pickerVisible = computed(() => pickerOpen.value && filteredVariables.value.length > 0);

function openPicker(range: SubjectRange, query: string, fromButton: boolean) {
	pickerRange = range;
	pickerFromButton = fromButton;
	if (!pickerOpen.value || pickerQuery.value !== query) pickerIndex.value = 0;
	pickerQuery.value = query;
	pickerTop.value = (frame.value?.offsetHeight ?? 30) + 4;
	pickerOpen.value = true;
}

function closePicker() {
	pickerOpen.value = false;
	pickerQuery.value = '';
	pickerIndex.value = 0;
}

function syncTrigger(element: HTMLInputElement) {
	const caret = element.selectionStart ?? element.value.length;
	const trigger = findSubjectVariableTrigger(element.value, caret);
	if (trigger) openPicker(trigger.range, trigger.query, false);
	else closePicker();
}

function handleInput(event: Event) {
	const element = event.target as HTMLInputElement;
	emit('update:value', element.value);
	if (canInsertVariables.value) syncTrigger(element);
}

function handleInsertButton() {
	const element = input.value;
	if (!element) return;
	const end = props.value.length;
	// A field that was never focused reports a caret at 0; append instead.
	const focused = document.activeElement === element;
	const range = focused
		? { start: element.selectionStart ?? end, end: element.selectionEnd ?? end }
		: { start: end, end };
	element.focus();
	element.setSelectionRange(range.start, range.end);
	openPicker(range, '', true);
}

async function pickVariable(variable: Variable) {
	const next = insertSubjectVariable(props.value, variable.key, pickerRange, {
		padBefore: pickerFromButton,
	});
	closePicker();
	// `maxlength` only stops typing; a token that does not fit is not inserted.
	if (props.maxLength !== undefined && next.value.length > props.maxLength) return;
	emit('update:value', next.value);
	await nextTick();
	input.value?.focus();
	input.value?.setSelectionRange(next.caret, next.caret);
}

function handleKeydown(event: KeyboardEvent) {
	if (!pickerVisible.value) return;
	if (event.key === 'ArrowDown') {
		event.preventDefault();
		pickerIndex.value = Math.min(pickerIndex.value + 1, filteredVariables.value.length - 1);
	} else if (event.key === 'ArrowUp') {
		event.preventDefault();
		pickerIndex.value = Math.max(pickerIndex.value - 1, 0);
	} else if (event.key === 'Enter' || event.key === 'Tab') {
		event.preventDefault();
		const selected = filteredVariables.value[pickerIndex.value];
		if (selected) void pickVariable(selected);
	} else if (event.key === 'Escape') {
		// Keep the editor's global Escape (clear selection / exit focus mode)
		// from also firing while the picker is what the user is dismissing.
		event.preventDefault();
		event.stopPropagation();
		closePicker();
	}
}
</script>

<template>
	<div class="relative">
		<div
			ref="frame"
			class="flex items-center rounded-md border bg-transparent transition-colors focus-within:border-brand focus-within:ring-1 focus-within:ring-brand/30"
			:class="
				warn
					? 'border-warning/60 hover:border-warning'
					: 'border-border-default hover:border-border-strong'
			"
		>
			<input
				:id="id"
				ref="input"
				:value="value"
				type="text"
				role="combobox"
				:aria-label="fieldLabel"
				aria-autocomplete="list"
				:aria-expanded="pickerVisible"
				:aria-controls="pickerVisible ? pickerId : undefined"
				:aria-activedescendant="pickerVisible ? `${pickerId}-option-${pickerIndex}` : undefined"
				:aria-describedby="describedBy"
				:maxlength="maxLength"
				autocomplete="off"
				class="flex-1 min-w-0 bg-transparent px-2 py-1 text-text-primary text-sm focus:outline-none"
				:placeholder="placeholder"
				@input="handleInput"
				@keydown="handleKeydown"
				@click="canInsertVariables && syncTrigger($event.target as HTMLInputElement)"
				@blur="closePicker"
			/>
			<UiTooltip v-if="canInsertVariables" :text="insertTitle">
				<button
					type="button"
					:data-testid="testId"
					class="mr-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary transition-colors"
					:aria-label="insertLabel"
					@mousedown.prevent
					@click="handleInsertButton"
				>
					<BracesIcon :size="12" />
					{{ t('builder.subject.variable') }}
				</button>
			</UiTooltip>
		</div>
		<VariablePickerMenu
			v-if="pickerVisible"
			:id="pickerId"
			:variables="filteredVariables"
			:query="pickerQuery"
			:selected-index="pickerIndex"
			:position="{ top: pickerTop, left: 0 }"
			@select="pickVariable"
		/>
	</div>
</template>
