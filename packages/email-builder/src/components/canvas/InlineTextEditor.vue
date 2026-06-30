<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import type { EditorBlock, EmailTheme, Variable, TextBlockContent, SlashCommand } from '../../types';
import { defaultPadding } from '../../defaults';
import { useSlashCommands } from '../../composables/useSlashCommands';
import { useRichText } from '@owlat/ui/composables/useRichText';
import SlashCommandMenu from './SlashCommandMenu.vue';
import VariablePickerMenu from './VariablePickerMenu.vue';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
	variables?: Variable[];
}>();

const emit = defineEmits<{
	(e: 'exit'): void;
	(e: 'slash-command-select', command: SlashCommand): void;
	(e: 'insert-block-after'): void;
	(e: 'open-link-dialog'): void;
}>();

const editorEl = shallowRef<HTMLElement | null>(null);
const wrapperEl = shallowRef<HTMLElement | null>(null);
let blurTimeout: ReturnType<typeof setTimeout> | null = null;

// Shared format primitives (Cmd+B/I/U). Slash commands, variable picker,
// link-dialog emission, and strikethrough remain local — they're specific
// to the campaign-builder context.
const richText = useRichText({ editorRef: editorEl });

const content = computed(() => props.block.content as TextBlockContent);

// Slash commands
const slashCommands = useSlashCommands();

// Track the position in text where "/" was typed
let slashStartOffset = -1;
let slashStartNode: Node | null = null;

// Variable picker state
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

// Compute editor styles from block properties
const editorStyles = computed(() => {
	const c = content.value;
	const t = props.theme;
	return {
		fontSize: `${c.fontSize || t.bodyFontSize || 16}px`,
		color: c.textColor || t.bodyTextColor || '#333333',
		fontFamily: c.fontFamily || t.fontFamily || 'Arial, sans-serif',
		fontWeight: c.fontWeight ? String(c.fontWeight) : 'normal',
		lineHeight: c.lineHeight ? String(c.lineHeight) : '1.5',
		textAlign: (c.textAlign || 'left') as 'left' | 'right' | 'center' | 'justify',
		letterSpacing: c.letterSpacing ? `${c.letterSpacing}px` : 'normal',
		textTransform: c.textTransform || 'none',
		textDecoration: c.textDecoration || 'none',
		paddingTop: `${c.paddingTop ?? defaultPadding.paddingTop}px`,
		paddingRight: `${c.paddingRight ?? defaultPadding.paddingRight}px`,
		paddingBottom: `${c.paddingBottom ?? defaultPadding.paddingBottom}px`,
		paddingLeft: `${c.paddingLeft ?? defaultPadding.paddingLeft}px`,
		backgroundColor: c.backgroundColor || 'transparent',
	};
});

function getCursorRect(): DOMRect | null {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return null;
	const range = selection.getRangeAt(0);
	const rect = range.getBoundingClientRect();
	return rect;
}

function getMenuPosition(): { top: number; left: number } {
	const cursorRect = getCursorRect();
	const wrapperRect = wrapperEl.value?.getBoundingClientRect();
	if (!cursorRect || !wrapperRect) return { top: 0, left: 0 };
	return {
		top: cursorRect.bottom - wrapperRect.top + 4,
		left: cursorRect.left - wrapperRect.left,
	};
}

function handleInput() {
	if (!editorEl.value) return;

	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return;

	const range = selection.getRangeAt(0);
	const node = range.startContainer;
	const offset = range.startOffset;

	if (node.nodeType !== Node.TEXT_NODE) {
		if (slashCommands.isOpen.value) slashCommands.close();
		if (variablePickerOpen.value) closeVariablePicker();
		return;
	}

	const text = node.textContent || '';
	const beforeCursor = text.slice(0, offset);

	// Check for variable picker triggers: "{{" or "@"
	if (props.variables?.length && !slashCommands.isOpen.value) {
		// Check for "{{" trigger first (higher priority)
		const doubleBraceMatch = beforeCursor.match(/\{\{([^}]*)$/);
		// Check for "@" trigger
		const atIdx = beforeCursor.lastIndexOf('@');
		const atValid = atIdx !== -1 && (atIdx === 0 || /\s/.test(text[atIdx - 1]!));

		// Use whichever trigger is closer to the cursor
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
				variablePickerPosition.value = getMenuPosition();
			}
			variablePickerOpen.value = true;
			variableQuery.value = query;
			variableSelectedIndex.value = 0;
			return;
		} else if (variablePickerOpen.value) {
			closeVariablePicker();
		}
	}

	// Check for "/" trigger (slash commands)
	const slashIdx = beforeCursor.lastIndexOf('/');

	if (slashIdx === -1) {
		if (slashCommands.isOpen.value) slashCommands.close();
		return;
	}

	// "/" must be at start or preceded by whitespace
	if (slashIdx > 0 && !/\s/.test(text[slashIdx - 1]!)) {
		if (slashCommands.isOpen.value) slashCommands.close();
		return;
	}

	const query = beforeCursor.slice(slashIdx + 1);

	if (!slashCommands.isOpen.value) {
		// Open the menu
		slashStartOffset = slashIdx;
		slashStartNode = node;
		const pos = getMenuPosition();
		slashCommands.open(pos);
	}

	slashCommands.updateQuery(query);
}

function closeVariablePicker() {
	variablePickerOpen.value = false;
	variableQuery.value = '';
	variableSelectedIndex.value = 0;
	triggerStartOffset = -1;
	triggerStartNode = null;
}

function cleanupTriggerText() {
	if (!editorEl.value || triggerStartNode === null || triggerStartOffset === -1) return;

	const text = triggerStartNode.textContent || '';
	const selection = window.getSelection();
	const cursorOffset = selection?.rangeCount ? selection.getRangeAt(0).startOffset : text.length;
	const endOffset = triggerStartNode === selection?.getRangeAt(0)?.startContainer ? cursorOffset : text.length;
	const before = text.slice(0, triggerStartOffset);
	const after = text.slice(endOffset);
	triggerStartNode.textContent = before + after;

	// Restore cursor position
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

function handleVariableSelect(variable: Variable) {
	cleanupTriggerText();

	// Insert variable span at cursor
	if (!editorEl.value) return;
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
		// Add a zero-width space after for cursor placement
		const spacer = document.createTextNode('\u200B');
		range.setStartAfter(span);
		range.insertNode(spacer);
		range.setStartAfter(spacer);
		range.setEndAfter(spacer);
		selection.removeAllRanges();
		selection.addRange(range);
	}

	closeVariablePicker();
}

function cleanupSlashText() {
	if (!editorEl.value || slashStartNode === null || slashStartOffset === -1) return;

	const text = slashStartNode.textContent || '';
	const selection = window.getSelection();
	const cursorOffset = selection?.rangeCount ? selection.getRangeAt(0).startOffset : text.length;
	// Remove from slashStartOffset to current cursor position
	const endOffset = slashStartNode === selection?.getRangeAt(0)?.startContainer ? cursorOffset : text.length;
	const before = text.slice(0, slashStartOffset);
	const after = text.slice(endOffset);
	slashStartNode.textContent = before + after;

	// Restore cursor position
	if (selection && slashStartNode.parentNode) {
		const range = document.createRange();
		range.setStart(slashStartNode, Math.min(slashStartOffset, (slashStartNode.textContent || '').length));
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
	}

	slashStartOffset = -1;
	slashStartNode = null;
}

function handleSlashSelect(command: SlashCommand) {
	cleanupSlashText();
	slashCommands.close();
	emit('slash-command-select', command);
}

function handleBlur() {
	// Delay to allow toolbar/menu clicks to register
	blurTimeout = setTimeout(() => {
		if (slashCommands.isOpen.value) slashCommands.close();
		if (variablePickerOpen.value) closeVariablePicker();
		emit('exit');
	}, 150);
}

function handleFocus() {
	if (blurTimeout) {
		clearTimeout(blurTimeout);
		blurTimeout = null;
	}
}

function isCursorAtEnd(): boolean {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || !editorEl.value) return false;
	const range = selection.getRangeAt(0);
	if (!range.collapsed) return false;

	// Create a range from cursor to end of editor
	const testRange = document.createRange();
	testRange.setStart(range.endContainer, range.endOffset);
	testRange.setEnd(editorEl.value as Node, editorEl.value.childNodes.length);
	// If the remaining content is empty or only whitespace, cursor is at end
	const remaining = testRange.toString();
	return remaining.trim().length === 0;
}

function handleKeydown(event: KeyboardEvent) {
	const metaOrCtrl = event.metaKey || event.ctrlKey;

	// --- Variable picker navigation ---
	if (variablePickerOpen.value) {
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
			if (selected) handleVariableSelect(selected);
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeVariablePicker();
			return;
		}
	}

	// --- Slash command navigation ---
	if (slashCommands.isOpen.value) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			event.stopPropagation();
			slashCommands.selectNext();
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			event.stopPropagation();
			slashCommands.selectPrevious();
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			event.stopPropagation();
			const cmd = slashCommands.confirm();
			if (cmd) {
				cleanupSlashText();
				emit('slash-command-select', cmd);
			}
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			slashCommands.close();
			return;
		}
		if (event.key === 'Tab') {
			event.preventDefault();
			event.stopPropagation();
			const cmd = slashCommands.confirm();
			if (cmd) {
				cleanupSlashText();
				emit('slash-command-select', cmd);
			}
			return;
		}
	}

	// --- Formatting keyboard shortcuts ---
	if (metaOrCtrl && !event.shiftKey) {
		if (event.key === 'b') {
			event.preventDefault();
			richText.toggleBold();
			return;
		}
		if (event.key === 'i') {
			event.preventDefault();
			richText.toggleItalic();
			return;
		}
		if (event.key === 'u') {
			event.preventDefault();
			richText.toggleUnderline();
			return;
		}
		if (event.key === 'k') {
			event.preventDefault();
			emit('open-link-dialog');
			return;
		}
	}
	if (metaOrCtrl && event.shiftKey) {
		if (event.key === 's' || event.key === 'S') {
			event.preventDefault();
			document.execCommand('strikeThrough');
			return;
		}
	}

	// --- Enter at end of text → create new block ---
	if (event.key === 'Enter' && !event.shiftKey && !metaOrCtrl) {
		if (isCursorAtEnd()) {
			event.preventDefault();
			emit('insert-block-after');
			return;
		}
		// Otherwise, default contenteditable behavior (newline)
	}

	// --- Escape: exit inline edit ---
	if (event.key === 'Escape') {
		event.preventDefault();
		event.stopPropagation();
		emit('exit');
	}
}

// Initialize with block HTML content
onMounted(() => {
	if (editorEl.value) {
		editorEl.value.innerHTML = content.value.html || '';
		nextTick(() => {
			editorEl.value?.focus();
			const selection = window.getSelection();
			if (selection && editorEl.value) {
				const range = document.createRange();
				range.selectNodeContents(editorEl.value);
				range.collapse(false);
				selection.removeAllRanges();
				selection.addRange(range);
			}
		});
	}
});

onUnmounted(() => {
	if (blurTimeout) {
		clearTimeout(blurTimeout);
	}
});

// Expose editor element for format commands
defineExpose({
	el: editorEl,
});
</script>

<template>
	<div ref="wrapperEl" class="relative z-[3]">
		<div
			ref="editorEl"
			class="w-full h-full outline-none cursor-text break-words overflow-wrap-break-word min-h-[1em]"
			data-inline-text
			:style="editorStyles"
			contenteditable="true"
			@blur="handleBlur"
			@focus="handleFocus"
			@keydown="handleKeydown"
			@input="handleInput"
		/>
		<SlashCommandMenu
			v-if="slashCommands.isOpen.value"
			:commands="slashCommands.filteredCommands.value"
			:selected-index="slashCommands.state.selectedIndex"
			:position="slashCommands.state.position"
			@select="handleSlashSelect"
		/>
		<VariablePickerMenu
			v-if="variablePickerOpen && filteredVariables.length > 0"
			:variables="filteredVariables"
			:query="variableQuery"
			:selected-index="variableSelectedIndex"
			:position="variablePickerPosition"
			@select="handleVariableSelect"
		/>
	</div>
</template>

<style>
[data-inline-text] a {
	color: inherit;
	text-decoration: underline;
}

[data-inline-text] span[data-variable],
[data-inline-text] .variable-tag {
	display: inline;
	background: rgba(196, 120, 90, 0.12);
	border: 1px solid rgba(196, 120, 90, 0.3);
	border-radius: 3px;
	padding: 0 3px;
	font-size: 0.9em;
	color: var(--color-brand);
	cursor: default;
}
</style>
