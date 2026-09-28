<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';
import { Braces, Plus, TriangleAlert } from '@lucide/vue';
import type { Variable } from '../../types';
import VariablePlaceholderTag from '../ui/VariablePlaceholderTag.vue';
import VariablePickerMenu from './VariablePickerMenu.vue';
import {
	findSubjectVariableTrigger,
	insertSubjectVariable,
	unknownSubjectVariables,
	type SubjectRange,
} from '../../utils/subjectVariables';

const props = defineProps<{
	name: string;
	subject: string;
	hideSubject: boolean;
	mode?: string;
	// Variables the subject line can reference. Feeds the `{{` picker and the
	// insert button; the send path personalizes the subject with the same keys.
	variables?: Variable[];
	// When set, render the data-variable manager strip. Only the transactional
	// editor (variableType: 'data') passes these — marketing personalization
	// variables come from contact fields and are not user-defined here.
	showDataVariables?: boolean;
	dataVariables?: Variable[];
}>();

const emit = defineEmits<{
	(e: 'update:name', value: string): void;
	(e: 'update:subject', value: string): void;
	/** Open the define-variable dialog, optionally prefilled with a key. */
	(e: 'add-variable', key?: string): void;
}>();

const nameId = useId();
const subjectId = useId();
const pickerId = useId();
const hintId = useId();

const subjectInput = ref<HTMLInputElement | null>(null);
const subjectFrame = ref<HTMLElement | null>(null);

const subjectVariables = computed(() => props.variables ?? []);
const canInsertVariables = computed(() => subjectVariables.value.length > 0);

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
	return subjectVariables.value.filter(
		(v) => v.key.toLowerCase().includes(q) || v.label.toLowerCase().includes(q)
	);
});
const pickerVisible = computed(() => pickerOpen.value && filteredVariables.value.length > 0);

function openPicker(range: SubjectRange, query: string, fromButton: boolean) {
	pickerRange = range;
	pickerFromButton = fromButton;
	if (!pickerOpen.value || pickerQuery.value !== query) pickerIndex.value = 0;
	pickerQuery.value = query;
	pickerTop.value = (subjectFrame.value?.offsetHeight ?? 30) + 4;
	pickerOpen.value = true;
}

function closePicker() {
	pickerOpen.value = false;
	pickerQuery.value = '';
	pickerIndex.value = 0;
}

function syncTrigger(input: HTMLInputElement) {
	const caret = input.selectionStart ?? input.value.length;
	const trigger = findSubjectVariableTrigger(input.value, caret);
	if (trigger) openPicker(trigger.range, trigger.query, false);
	else closePicker();
}

function handleSubjectInput(event: Event) {
	const input = event.target as HTMLInputElement;
	emit('update:subject', input.value);
	if (canInsertVariables.value) syncTrigger(input);
}

function handleInsertButton() {
	const input = subjectInput.value;
	if (!input) return;
	const end = props.subject.length;
	// A field that was never focused reports a caret at 0; append instead.
	const focused = document.activeElement === input;
	const range = focused
		? { start: input.selectionStart ?? end, end: input.selectionEnd ?? end }
		: { start: end, end };
	input.focus();
	input.setSelectionRange(range.start, range.end);
	openPicker(range, '', true);
}

async function pickVariable(variable: Variable) {
	const next = insertSubjectVariable(props.subject, variable.key, pickerRange, {
		padBefore: pickerFromButton,
	});
	closePicker();
	emit('update:subject', next.value);
	await nextTick();
	subjectInput.value?.focus();
	subjectInput.value?.setSelectionRange(next.caret, next.caret);
}

function handleSubjectKeydown(event: KeyboardEvent) {
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

// Only a data-variable email declares its full key set; for any other editor
// a key missing from `variables` is not evidence of a typo.
const unknownKeys = computed(() =>
	props.showDataVariables
		? unknownSubjectVariables(
				props.subject,
				subjectVariables.value.map((v) => v.key)
			)
		: []
);
const token = (key: string) => `{{${key}}}`;
const isSubjectEmpty = computed(() => props.subject.trim() === '');

const subjectPlaceholder = computed(() =>
	canInsertVariables.value ? 'Add a subject, type {{ to insert a variable' : 'Email subject line'
);
</script>

<template>
	<div
		data-testid="subject-fields"
		class="flex flex-col gap-2 pb-4 mb-2 border-b border-border-subtle"
	>
		<div class="flex items-center gap-3">
			<label :for="nameId" class="text-xs font-medium text-text-secondary w-16 shrink-0 text-right">
				Name
			</label>
			<input
				:id="nameId"
				:value="name"
				type="text"
				:aria-label="mode === 'block' ? 'Block name' : 'Template name'"
				class="flex-1 min-w-0 rounded-md border border-transparent bg-transparent px-2 py-1 text-text-primary font-medium text-sm focus:outline-none hover:border-border-default focus:border-brand transition-colors"
				:placeholder="mode === 'block' ? 'Block name' : 'Template name'"
				@input="emit('update:name', ($event.target as HTMLInputElement).value)"
			/>
		</div>
		<div v-if="!hideSubject" class="flex items-start gap-3">
			<label
				:for="subjectId"
				class="text-xs font-medium text-text-secondary w-16 shrink-0 text-right pt-[7px]"
			>
				Subject
			</label>
			<div class="flex-1 min-w-0">
				<div class="relative">
					<div
						ref="subjectFrame"
						class="flex items-center rounded-md border bg-transparent transition-colors focus-within:border-brand focus-within:ring-1 focus-within:ring-brand/30"
						:class="
							isSubjectEmpty || unknownKeys.length
								? 'border-warning/60 hover:border-warning'
								: 'border-border-default hover:border-border-strong'
						"
					>
						<input
							:id="subjectId"
							ref="subjectInput"
							:value="subject"
							type="text"
							role="combobox"
							aria-label="Email subject line"
							aria-autocomplete="list"
							:aria-expanded="pickerVisible"
							:aria-controls="pickerVisible ? pickerId : undefined"
							:aria-describedby="isSubjectEmpty || unknownKeys.length ? hintId : undefined"
							autocomplete="off"
							class="flex-1 min-w-0 bg-transparent px-2 py-1 text-text-primary text-sm focus:outline-none"
							:placeholder="subjectPlaceholder"
							@input="handleSubjectInput"
							@keydown="handleSubjectKeydown"
							@click="canInsertVariables && syncTrigger($event.target as HTMLInputElement)"
							@blur="closePicker"
						/>
						<button
							v-if="canInsertVariables"
							type="button"
							data-testid="subject-insert-variable"
							class="mr-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary transition-colors"
							title="Insert a variable into the subject"
							aria-label="Insert variable into subject"
							@mousedown.prevent
							@click="handleInsertButton"
						>
							<Braces :size="12" />
							Variable
						</button>
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

				<p
					v-if="isSubjectEmpty"
					:id="hintId"
					class="mt-1 flex items-center gap-1 text-xs text-warning"
				>
					<TriangleAlert :size="12" class="shrink-0" />
					No subject yet. Recipients would see an empty subject line.
				</p>
				<div
					v-else-if="unknownKeys.length"
					:id="hintId"
					class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-warning"
				>
					<TriangleAlert :size="12" class="shrink-0" />
					<span>
						<template v-for="(key, index) in unknownKeys" :key="key">
							<span v-if="index > 0">, </span>
							<code class="font-mono">{{ token(key) }}</code>
						</template>
						{{ unknownKeys.length === 1 ? "isn't a variable" : "aren't variables" }} of this email,
						so {{ unknownKeys.length === 1 ? 'it is' : 'they are' }} sent empty.
					</span>
					<button
						v-for="key in unknownKeys"
						:key="`define-${key}`"
						type="button"
						class="rounded px-1 font-medium text-text-secondary underline underline-offset-2 hover:text-text-primary"
						@click="emit('add-variable', key)"
					>
						Define {{ key }}
					</button>
				</div>
			</div>
		</div>

		<!-- Data variables manager — the only in-editor affordance to DEFINE a new
		     data variable. Without it a freshly created transactional email has an
		     empty schema and the user can reference variables but never add one. -->
		<div v-if="showDataVariables" class="flex items-baseline gap-3 pt-1">
			<label class="text-xs font-medium text-text-secondary w-16 shrink-0 text-right"
				>Variables</label
			>
			<div class="flex-1 flex flex-wrap items-center gap-1.5">
				<VariablePlaceholderTag
					v-for="variable in dataVariables"
					:key="variable.key"
					:label="variable.key"
				/>
				<button
					type="button"
					class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-dashed border-border-default text-xs text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary hover:border-border-strong transition-colors"
					title="Define a new data variable for this email"
					@click="emit('add-variable')"
				>
					<Plus :size="12" />
					New variable
				</button>
			</div>
		</div>
	</div>
</template>
