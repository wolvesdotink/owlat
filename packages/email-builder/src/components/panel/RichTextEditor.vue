<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from 'vue';
import { useRichText } from '@owlat/ui/composables/useRichText';
import { sanitizeEditorHtml } from '@owlat/email-renderer';
import type { Variable } from '../../types';
import { insertVariableChip, useVariableTrigger } from '../../composables/useVariableTrigger';
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

// Formatting (toolbar and Cmd/Ctrl+B/I/U/K) shares the Range-based helpers the
// canvas inline editor uses; Cmd/Ctrl+K and the Link button prompt for the URL.
const richText = useRichText({ editorRef, onChange: emitHtml });

// Inline variable picker, triggered by "{{" or "@".
const variablePicker = useVariableTrigger({
	variables: () => props.variables,
	wrapperEl: wrapperRef,
	onSelect: emitHtml,
});

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
const modKey = isMac ? '⌘' : 'Ctrl';

// Sync content from prop to editor. Stored HTML is sanitized before it enters
// the live contenteditable, on mount and on every prop change.
onMounted(() => {
	if (editorRef.value) {
		editorRef.value.innerHTML = sanitizeEditorHtml(props.value);
	}
});

// The last value this editor emitted. Its echo back through the prop is
// skipped, so typing never resets the caret or rewrites the source textarea
// (the sanitizer's serialization differs from the browser's `innerHTML`).
let lastEmitted: string | null = null;

watch(
	() => props.value,
	(newVal) => {
		if (newVal === lastEmitted) return;
		lastEmitted = null;
		const safe = sanitizeEditorHtml(newVal);
		if (editorRef.value && sanitizeEditorHtml(editorRef.value.innerHTML) !== safe) {
			editorRef.value.innerHTML = safe;
		}
		if (isSourceMode.value) {
			sourceValue.value = newVal;
		}
	}
);

function emitSanitized(html: string) {
	lastEmitted = sanitizeEditorHtml(html);
	emit('update', lastEmitted);
}

function emitHtml() {
	if (!editorRef.value) return;
	emitSanitized(editorRef.value.innerHTML);
}

function handleInput() {
	emitHtml();
	nextTick(() => variablePicker.detect());
}

function handleKeydown(event: KeyboardEvent) {
	if (variablePicker.handleKeydown(event)) return;
	richText.handleFormatKeydown(event);
}

async function applyFormat(format: () => void | Promise<void>) {
	await format();
	editorRef.value?.focus();
}

function insertVariable(variable: Variable) {
	if (!editorRef.value) return;
	insertVariableChip(variable, editorRef.value);
	showVariableMenu.value = false;
	emitHtml();
}

function toggleSourceMode() {
	if (isSourceMode.value) {
		emitSanitized(sourceValue.value);
	} else {
		sourceValue.value = props.value;
	}
	isSourceMode.value = !isSourceMode.value;
}

function handleSourceInput(event: Event) {
	sourceValue.value = (event.target as HTMLTextAreaElement).value;
	emitSanitized(sourceValue.value);
}
</script>

<template>
	<div
		ref="wrapperRef"
		class="relative border border-border-subtle rounded-lg transition-[border-color,box-shadow] duration-(--motion-fast) focus-within:border-brand/50 focus-within:shadow-[0_0_0_3px_rgba(196,120,90,0.06)]"
	>
		<!-- Toolbar -->
		<div
			class="flex items-center gap-px p-1 border-b border-border-subtle rounded-t-lg bg-bg-surface"
			role="toolbar"
			aria-label="Text formatting"
		>
			<button
				type="button"
				class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary"
				:title="`Bold (${modKey}+B)`"
				aria-label="Bold"
				@click="applyFormat(richText.toggleBold)"
			>
				<Bold :size="14" />
			</button>
			<button
				type="button"
				class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary"
				:title="`Italic (${modKey}+I)`"
				aria-label="Italic"
				@click="applyFormat(richText.toggleItalic)"
			>
				<Italic :size="14" />
			</button>
			<button
				type="button"
				class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary"
				:title="`Underline (${modKey}+U)`"
				aria-label="Underline"
				@click="applyFormat(richText.toggleUnderline)"
			>
				<Underline :size="14" />
			</button>
			<button
				type="button"
				class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary"
				:title="`Link (${modKey}+K)`"
				aria-label="Link"
				@click="applyFormat(richText.setLink)"
			>
				<Link :size="14" />
			</button>
			<div v-if="variables?.length" class="w-px h-[18px] bg-border-subtle mx-0.5" />
			<div v-if="variables?.length" class="relative">
				<button
					type="button"
					class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary"
					title="Insert variable"
					aria-label="Insert variable"
					aria-haspopup="menu"
					:aria-expanded="showVariableMenu"
					@click="showVariableMenu = !showVariableMenu"
				>
					<VariableIcon :size="14" />
				</button>
				<div
					v-if="showVariableMenu"
					role="menu"
					aria-label="Variables"
					class="absolute top-full left-0 z-10 min-w-40 p-1 bg-bg-elevated border border-border-subtle rounded-lg shadow-[0_4px_16px_rgba(0,0,0,0.25),0_1px_3px_rgba(0,0,0,0.15)]"
				>
					<button
						v-for="v in variables"
						:key="v.key"
						type="button"
						role="menuitem"
						class="block w-full py-1.5 px-2 text-xs text-left border-none rounded bg-none text-text-primary cursor-pointer transition-[background-color] duration-(--motion-fast) hover:bg-bg-surface-hover"
						@click="insertVariable(v)"
					>
						{{ v.key }}
					</button>
				</div>
			</div>
			<div class="flex-1" />
			<button
				type="button"
				class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary"
				:class="{ 'bg-brand text-white': isSourceMode }"
				title="Source mode"
				aria-label="Source mode"
				:aria-pressed="isSourceMode"
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
			role="textbox"
			aria-multiline="true"
			aria-label="Rich text content"
			@input="handleInput"
			@keydown="handleKeydown"
			@blur="variablePicker.close"
		/>

		<!-- Source editor -->
		<textarea
			v-else
			class="w-full min-h-20 p-2 text-xs font-mono border-none rounded-b-lg resize-y outline-none text-text-primary bg-bg-surface"
			aria-label="HTML source"
			:value="sourceValue"
			rows="6"
			@input="handleSourceInput"
		/>

		<!-- Inline variable picker (triggered by "{{" or "@") -->
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
