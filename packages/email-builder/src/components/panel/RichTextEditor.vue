<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import type { Variable } from '../../types';
import { sanitizeHtml } from '../../utils/htmlSanitizer';
import { Bold, Italic, Underline, Link, Code, Variable as VariableIcon } from '@lucide/vue';
import VariablePickerMenu from '../canvas/VariablePickerMenu.vue';

const props = defineProps<{
	value: string;
	variables?: Variable[];
}>();

const emit = defineEmits<{
	(e: 'update', value: string): void;
}>();

const editorRef = ref<HTMLDivElement | null>(null);
const wrapperRef = ref<HTMLElement | null>(null);
const isSourceMode = ref(false);
const sourceValue = ref('');
const showVariableMenu = ref(false);

// Inline variable picker state (triggered by "{{")
const variablePickerOpen = ref(false);
const variableQuery = ref('');
const variableSelectedIndex = ref(0);
const variablePickerPosition = ref({ top: 0, left: 0 });
let triggerStartOffset = -1;
let triggerStartNode: Node | null = null;

const filteredVariables = computed(() => {
	if (!props.variables?.length) return [];
	const q = variableQuery.value.toLowerCase();
	return props.variables.filter((v) =>
		v.key.toLowerCase().includes(q) || v.label.toLowerCase().includes(q),
	);
});

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
const modKey = isMac ? '⌘' : 'Ctrl';

// Sync content from prop to editor
onMounted(() => {
	if (editorRef.value) {
		editorRef.value.innerHTML = props.value;
	}
});

watch(
	() => props.value,
	(newVal) => {
		if (editorRef.value && editorRef.value.innerHTML !== newVal) {
			editorRef.value.innerHTML = newVal;
		}
		if (isSourceMode.value) {
			sourceValue.value = newVal;
		}
	},
);

function getPickerMenuPosition(): { top: number; left: number } {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return { top: 0, left: 0 };
	const cursorRect = selection.getRangeAt(0).getBoundingClientRect();
	const wrapperRect = wrapperRef.value?.getBoundingClientRect();
	if (!cursorRect || !wrapperRect) return { top: 0, left: 0 };
	return {
		top: cursorRect.bottom - wrapperRect.top + 4,
		left: cursorRect.left - wrapperRect.left,
	};
}

function closeVariablePicker() {
	variablePickerOpen.value = false;
	variableQuery.value = '';
	variableSelectedIndex.value = 0;
	triggerStartOffset = -1;
	triggerStartNode = null;
}

function cleanupTriggerText() {
	if (!editorRef.value || triggerStartNode === null || triggerStartOffset === -1) return;

	const text = triggerStartNode.textContent || '';
	const selection = window.getSelection();
	const cursorOffset = selection?.rangeCount ? selection.getRangeAt(0).startOffset : text.length;
	const endOffset = triggerStartNode === selection?.getRangeAt(0)?.startContainer ? cursorOffset : text.length;
	const before = text.slice(0, triggerStartOffset);
	const after = text.slice(endOffset);
	triggerStartNode.textContent = before + after;

	if (selection && triggerStartNode.parentNode) {
		const range = document.createRange();
		range.setStart(triggerStartNode, Math.min(triggerStartOffset, (triggerStartNode.textContent || '').length));
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
	}

	triggerStartOffset = -1;
	triggerStartNode = null;
}

function handleVariablePickerSelect(variable: Variable) {
	cleanupTriggerText();
	insertVariable(variable);
	closeVariablePicker();
}

function detectVariableTrigger() {
	if (!props.variables?.length) return;

	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return;

	const range = selection.getRangeAt(0);
	const node = range.startContainer;
	const offset = range.startOffset;

	if (node.nodeType !== Node.TEXT_NODE) {
		if (variablePickerOpen.value) closeVariablePicker();
		return;
	}

	const text = node.textContent || '';
	const beforeCursor = text.slice(0, offset);

	// Check for "{{" trigger
	const doubleBraceMatch = beforeCursor.match(/\{\{([^}]*)$/);
	// Check for "@" trigger
	const atIdx = beforeCursor.lastIndexOf('@');
	const atValid = atIdx !== -1 && (atIdx === 0 || /\s/.test(text[atIdx - 1]!));

	let matchedTriggerIdx = -1;
	let query = '';

	if (doubleBraceMatch) {
		const braceIdx = beforeCursor.lastIndexOf('{{');
		if (atValid && atIdx > braceIdx) {
			matchedTriggerIdx = atIdx;
			query = beforeCursor.slice(atIdx + 1);
		} else {
			matchedTriggerIdx = braceIdx;
			query = doubleBraceMatch[1]!;
		}
	} else if (atValid) {
		matchedTriggerIdx = atIdx;
		query = beforeCursor.slice(atIdx + 1);
	}

	if (matchedTriggerIdx !== -1) {
		if (!variablePickerOpen.value) {
			triggerStartOffset = matchedTriggerIdx;
			triggerStartNode = node;
			variablePickerPosition.value = getPickerMenuPosition();
		}
		variablePickerOpen.value = true;
		variableQuery.value = query;
		variableSelectedIndex.value = 0;
	} else if (variablePickerOpen.value) {
		closeVariablePicker();
	}
}

function handleKeydown(event: KeyboardEvent) {
	if (!variablePickerOpen.value) return;

	if (event.key === 'ArrowDown') {
		event.preventDefault();
		event.stopPropagation();
		variableSelectedIndex.value = Math.min(
			variableSelectedIndex.value + 1,
			filteredVariables.value.length - 1,
		);
		return;
	}
	if (event.key === 'ArrowUp') {
		event.preventDefault();
		event.stopPropagation();
		variableSelectedIndex.value = Math.max(variableSelectedIndex.value - 1, 0);
		return;
	}
	if (event.key === 'Enter' || event.key === 'Tab') {
		event.preventDefault();
		event.stopPropagation();
		const selected = filteredVariables.value[variableSelectedIndex.value];
		if (selected) handleVariablePickerSelect(selected);
		return;
	}
	if (event.key === 'Escape') {
		event.preventDefault();
		event.stopPropagation();
		closeVariablePicker();
	}
}

function handleInput() {
	if (!editorRef.value) return;
	const html = sanitizeHtml(editorRef.value.innerHTML);
	emit('update', html);
	// Detect variable triggers after updating
	nextTick(() => detectVariableTrigger());
}

function execCommand(command: string, value?: string) {
	document.execCommand(command, false, value);
	editorRef.value?.focus();
	handleInput();
}

function toggleBold() {
	execCommand('bold');
}

function toggleItalic() {
	execCommand('italic');
}

function toggleUnderline() {
	execCommand('underline');
}

function insertLink() {
	const url = prompt('Enter URL:');
	if (url) {
		execCommand('createLink', url);
	}
}

function insertVariable(variable: Variable) {
	if (!editorRef.value) return;
	const span = document.createElement('span');
	span.className = 'variable-tag';
	span.contentEditable = 'false';
	span.dataset['variable'] = variable.key;
	span.textContent = `{{${variable.key}}}`;

	const selection = window.getSelection();
	if (selection && selection.rangeCount > 0) {
		const range = selection.getRangeAt(0);
		range.deleteContents();
		range.insertNode(span);
		range.setStartAfter(span);
		range.setEndAfter(span);
		selection.removeAllRanges();
		selection.addRange(range);
	}

	showVariableMenu.value = false;
	handleInput();
}

function toggleSourceMode() {
	if (isSourceMode.value) {
		emit('update', sanitizeHtml(sourceValue.value));
	} else {
		sourceValue.value = props.value;
	}
	isSourceMode.value = !isSourceMode.value;
}

function handleSourceInput(event: Event) {
	sourceValue.value = (event.target as HTMLTextAreaElement).value;
	emit('update', sanitizeHtml(sourceValue.value));
}
</script>

<template>
	<div ref="wrapperRef" data-rich-text class="relative border border-border-subtle rounded-lg overflow-hidden transition-[border-color,box-shadow] duration-150 focus-within:border-brand/50 focus-within:shadow-[0_0_0_3px_rgba(196,120,90,0.06)]">
		<!-- Toolbar -->
		<div class="flex items-center gap-px p-1 border-b border-border-subtle bg-bg-surface">
			<button
				type="button"
				class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-75 hover:bg-bg-surface-hover hover:text-text-primary"
				:title="`Bold (${modKey}+B)`"
				@click="toggleBold"
			>
				<Bold :size="14" />
			</button>
			<button
				type="button"
				class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-75 hover:bg-bg-surface-hover hover:text-text-primary"
				:title="`Italic (${modKey}+I)`"
				@click="toggleItalic"
			>
				<Italic :size="14" />
			</button>
			<button
				type="button"
				class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-75 hover:bg-bg-surface-hover hover:text-text-primary"
				:title="`Underline (${modKey}+U)`"
				@click="toggleUnderline"
			>
				<Underline :size="14" />
			</button>
			<button
				type="button"
				class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-75 hover:bg-bg-surface-hover hover:text-text-primary"
				:title="`Link (${modKey}+K)`"
				@click="insertLink"
			>
				<Link :size="14" />
			</button>
			<div v-if="variables?.length" class="w-px h-[18px] bg-border-subtle mx-0.5" />
			<div v-if="variables?.length" class="relative">
				<button
					type="button"
					class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-75 hover:bg-bg-surface-hover hover:text-text-primary"
					title="Insert variable"
					@click="showVariableMenu = !showVariableMenu"
				>
					<VariableIcon :size="14" />
				</button>
				<div v-if="showVariableMenu" class="absolute top-full left-0 z-10 min-w-40 p-1 bg-bg-elevated border border-border-subtle rounded-lg shadow-[0_4px_16px_rgba(0,0,0,0.25),0_1px_3px_rgba(0,0,0,0.15)]">
					<button
						v-for="v in variables"
						:key="v.key"
						type="button"
						class="block w-full py-1.5 px-2 text-xs text-left border-none rounded bg-none text-text-primary cursor-pointer transition-[background-color] duration-75 hover:bg-bg-surface-hover"
						@click="insertVariable(v)"
					>
						{{ v.key }}
					</button>
				</div>
			</div>
			<div class="flex-1" />
			<button
				type="button"
				class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-75 hover:bg-bg-surface-hover hover:text-text-primary"
				:class="{ 'bg-brand text-white': isSourceMode }"
				title="Source mode"
				@click="toggleSourceMode"
			>
				<Code :size="14" />
			</button>
		</div>

		<!-- Visual editor -->
		<div
			v-if="!isSourceMode"
			ref="editorRef"
			class="min-h-20 max-h-[200px] overflow-y-auto p-2 text-[13px] leading-[1.5] text-text-primary outline-none"
			contenteditable="true"
			@input="handleInput"
			@keydown="handleKeydown"
			@blur="closeVariablePicker"
		/>

		<!-- Source editor -->
		<textarea
			v-else
			class="w-full min-h-20 p-2 text-xs font-mono border-none resize-y outline-none text-text-primary bg-bg-surface"
			:value="sourceValue"
			rows="6"
			@input="handleSourceInput"
		/>

		<!-- Inline variable picker (triggered by "{{" or "@") -->
		<VariablePickerMenu
			v-if="variablePickerOpen && filteredVariables.length > 0"
			:variables="filteredVariables"
			:query="variableQuery"
			:selected-index="variableSelectedIndex"
			:position="variablePickerPosition"
			@select="handleVariablePickerSelect"
		/>
	</div>
</template>

<style>
[data-rich-text] :deep(.variable-tag) {
	display: inline;
	padding: 1px 4px;
	border-radius: 3px;
	background: rgba(196, 120, 90, 0.12);
	color: var(--color-brand);
	font-size: 12px;
	font-weight: 500;
}
</style>
