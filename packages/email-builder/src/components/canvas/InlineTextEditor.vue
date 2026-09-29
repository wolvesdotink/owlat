<script setup lang="ts">
import { shallowRef, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { moduleFor } from '@owlat/email-renderer';
import type {
	EditorBlock,
	EmailTheme,
	Variable,
	TextBlockContent,
	SlashCommand,
} from '../../types';
import { defaultPadding } from '../../defaults';
import { useSlashCommands } from '../../composables/useSlashCommands';
import {
	menuPosition,
	removeTextRange,
	useVariableTrigger,
} from '../../composables/useVariableTrigger';
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

// Same theme-defaults application as TextPreview: keep the inline editor's
// typography identical to what the Walker renders, so entering edit mode
// doesn't visibly reflow the block.
const content = computed(() => {
	const raw = props.block.content as TextBlockContent;
	const applied = moduleFor('text')?.applyTheme?.(raw as never, props.theme);
	return (applied as TextBlockContent | undefined) ?? raw;
});

// Slash commands
const slashCommands = useSlashCommands();

// Track the position in text where "/" was typed
let slashStartOffset = -1;
let slashStartNode: Node | null = null;

// Variable picker ("{{" or "@")
const variablePicker = useVariableTrigger({
	variables: () => props.variables,
	wrapperEl,
});

// Compute editor styles from block properties
const editorStyles = computed(() => {
	const c = content.value;
	const t = props.theme;
	const isHeading = c.blockType === 'h1' || c.blockType === 'h2' || c.blockType === 'h3';
	return {
		fontSize: `${c.fontSize || t.bodyFontSize || 16}px`,
		color: c.textColor || t.bodyTextColor || '#333333',
		fontFamily: c.fontFamily || t.fontFamily || 'Arial, sans-serif',
		// Headings render UA-bold in email clients when fontWeight is unset —
		// mirror TextPreview so entering edit mode doesn't change the weight.
		fontWeight: c.fontWeight ? String(c.fontWeight) : isHeading ? 'bold' : 'normal',
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

function handleInput() {
	if (!editorEl.value) return;

	// Variable triggers take precedence, but only while the slash menu is closed.
	if (!slashCommands.isOpen.value && variablePicker.detect()) return;

	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return;

	const range = selection.getRangeAt(0);
	const node = range.startContainer;
	const offset = range.startOffset;

	if (node.nodeType !== Node.TEXT_NODE) {
		if (slashCommands.isOpen.value) slashCommands.close();
		return;
	}

	const text = node.textContent || '';
	const beforeCursor = text.slice(0, offset);

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
		slashCommands.open(menuPosition(wrapperEl.value));
	}

	slashCommands.updateQuery(query);
}

function cleanupSlashText() {
	if (slashStartNode !== null && slashStartOffset !== -1) {
		removeTextRange(slashStartNode, slashStartOffset);
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
		variablePicker.close();
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
	if (variablePicker.handleKeydown(event)) return;

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
			v-if="variablePicker.open.value && variablePicker.filteredVariables.value.length > 0"
			:variables="variablePicker.filteredVariables.value"
			:query="variablePicker.query.value"
			:selected-index="variablePicker.selectedIndex.value"
			:position="variablePicker.position.value"
			@select="variablePicker.select"
		/>
	</div>
</template>

<style>
[data-inline-text] a {
	color: inherit;
	text-decoration: underline;
}
</style>
