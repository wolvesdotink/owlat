<script setup lang="ts">
import UiTooltip from '@owlat/ui/components/ui/Tooltip.vue';
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useRichText } from '@owlat/ui/composables/useRichText';
import { sanitizeEditorHtml } from '@owlat/email-renderer';
import type { Variable } from '../../types';
import { insertVariableChip, useVariableTrigger } from '../../composables/useVariableTrigger';
import {
	BoldIcon,
	CodeIcon,
	ItalicIcon,
	LinkIcon,
	UnderlineIcon,
	VariableIcon,
} from '@coolicons/vue';
import VariablePickerMenu from '../canvas/VariablePickerMenu.vue';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t, label } = useBuilderI18n();

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
const modKey = computed(() => (isMac ? '⌘' : label('Ctrl')));
const shortcutTitle = (key: string, letter: string) => `${t(key)} (${modKey.value}+${letter})`;

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
	const leavingSource = isSourceMode.value;
	if (leavingSource) {
		emitSanitized(sourceValue.value);
	} else {
		sourceValue.value = props.value;
	}
	isSourceMode.value = !isSourceMode.value;
	// The visual editor is v-if, so leaving source mode mounts a new, empty
	// contenteditable. Neither onMounted (the component is already mounted) nor
	// the prop watcher (the echo of what was just emitted is skipped) fills it.
	if (leavingSource) {
		nextTick(() => {
			if (editorRef.value)
				editorRef.value.innerHTML = lastEmitted ?? sanitizeEditorHtml(props.value);
		});
	}
}

// The toolbar's variable menu: focus moves onto its first item, ↓ ↑ move,
// Escape closes it and returns focus to its button, and a press outside closes
// it.
const variableMenuRef = ref<HTMLElement | null>(null);
const variableButtonRef = ref<HTMLButtonElement | null>(null);

function variableMenuItems(): HTMLButtonElement[] {
	return Array.from(
		variableMenuRef.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []
	);
}

function toggleVariableMenu() {
	showVariableMenu.value = !showVariableMenu.value;
	if (showVariableMenu.value) nextTick(() => variableMenuItems()[0]?.focus());
}

function closeVariableMenu(restoreFocus: boolean) {
	showVariableMenu.value = false;
	if (restoreFocus) variableButtonRef.value?.focus();
}

function onVariableMenuKeydown(event: KeyboardEvent) {
	const items = variableMenuItems();
	const current = items.indexOf(document.activeElement as HTMLButtonElement);
	if (event.key === 'ArrowDown') {
		event.preventDefault();
		items[(current + 1) % items.length]?.focus();
	} else if (event.key === 'ArrowUp') {
		event.preventDefault();
		items[(current - 1 + items.length) % items.length]?.focus();
	} else if (event.key === 'Escape') {
		event.preventDefault();
		event.stopPropagation();
		closeVariableMenu(true);
	} else if (event.key === 'Tab') {
		closeVariableMenu(false);
	}
}

function onDocumentPointerdown(event: PointerEvent) {
	if (!showVariableMenu.value) return;
	const target = event.target as Node;
	if (variableMenuRef.value?.contains(target) || variableButtonRef.value?.contains(target)) return;
	closeVariableMenu(false);
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerdown));
onUnmounted(() => document.removeEventListener('pointerdown', onDocumentPointerdown));

function handleSourceInput(event: Event) {
	sourceValue.value = (event.target as HTMLTextAreaElement).value;
	emitSanitized(sourceValue.value);
}
</script>

<template>
	<div
		ref="wrapperRef"
		class="relative border border-border-strong rounded-lg transition-[border-color,box-shadow] duration-(--motion-fast) focus-within:border-brand/50 focus-within:shadow-[0_0_0_3px_rgba(196,120,90,0.06)]"
	>
		<!-- Toolbar -->
		<div
			class="flex items-center gap-px p-1 border-b border-border-subtle rounded-t-lg bg-bg-surface"
			role="toolbar"
			:aria-label="t('builder.richText.formatting')"
		>
			<UiTooltip :text="shortcutTitle('builder.toolbar.bold', 'B')">
				<button
					type="button"
					class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary"
					:aria-label="t('builder.toolbar.bold')"
					@click="applyFormat(richText.toggleBold)"
				>
					<BoldIcon :size="14" />
				</button>
			</UiTooltip>
			<UiTooltip :text="shortcutTitle('builder.toolbar.italic', 'I')">
				<button
					type="button"
					class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary"
					:aria-label="t('builder.toolbar.italic')"
					@click="applyFormat(richText.toggleItalic)"
				>
					<ItalicIcon :size="14" />
				</button>
			</UiTooltip>
			<UiTooltip :text="shortcutTitle('builder.toolbar.underline', 'U')">
				<button
					type="button"
					class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary"
					:aria-label="t('builder.toolbar.underline')"
					@click="applyFormat(richText.toggleUnderline)"
				>
					<UnderlineIcon :size="14" />
				</button>
			</UiTooltip>
			<UiTooltip :text="shortcutTitle('builder.toolbar.link', 'K')">
				<button
					type="button"
					class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary"
					:aria-label="t('builder.toolbar.link')"
					@click="applyFormat(richText.setLink)"
				>
					<LinkIcon :size="14" />
				</button>
			</UiTooltip>
			<div v-if="variables?.length" class="w-px h-[18px] bg-border-subtle mx-0.5" />
			<div v-if="variables?.length" class="relative">
				<UiTooltip :text="t('builder.richText.insertVariable')">
					<button
						ref="variableButtonRef"
						type="button"
						class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary"
						:aria-label="t('builder.richText.insertVariable')"
						aria-haspopup="menu"
						:aria-expanded="showVariableMenu"
						@click="toggleVariableMenu"
					>
						<VariableIcon :size="14" />
					</button>
				</UiTooltip>
				<div
					v-if="showVariableMenu"
					ref="variableMenuRef"
					role="menu"
					:aria-label="t('builder.variables.title')"
					class="absolute top-full left-0 z-10 min-w-40 p-1 bg-bg-elevated border border-border-subtle rounded-lg shadow-[0_4px_16px_rgba(0,0,0,0.25),0_1px_3px_rgba(0,0,0,0.15)]"
					@keydown="onVariableMenuKeydown"
				>
					<button
						v-for="v in variables"
						:key="v.key"
						type="button"
						role="menuitem"
						tabindex="-1"
						class="block w-full py-1.5 px-2 text-xs text-left border-none rounded bg-none text-text-primary cursor-pointer transition-[background-color] duration-(--motion-fast) hover:bg-bg-surface-hover focus-visible:outline-none focus-visible:bg-bg-surface-hover"
						@click="insertVariable(v)"
					>
						{{ v.key }}
					</button>
				</div>
			</div>
			<div class="flex-1" />
			<UiTooltip :text="t('builder.richText.sourceMode')">
				<button
					type="button"
					class="flex items-center justify-center w-[26px] h-[26px] border-none rounded bg-none text-text-secondary cursor-pointer transition-[background-color,color] duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary"
					:class="{ 'bg-brand text-white': isSourceMode }"
					:aria-label="t('builder.richText.sourceMode')"
					:aria-pressed="isSourceMode"
					@click="toggleSourceMode"
				>
					<CodeIcon :size="14" />
				</button>
			</UiTooltip>
		</div>

		<!-- Visual editor -->
		<div
			v-if="!isSourceMode"
			ref="editorRef"
			class="min-h-20 max-h-[200px] overflow-y-auto p-2 text-caption leading-[1.5] text-text-primary outline-none"
			contenteditable="true"
			role="textbox"
			aria-multiline="true"
			:aria-label="t('builder.richText.content')"
			@input="handleInput"
			@keydown="handleKeydown"
			@blur="variablePicker.close"
		/>

		<!-- Source editor -->
		<textarea
			v-else
			class="w-full min-h-20 p-2 text-xs font-mono border-none rounded-b-lg resize-y outline-none text-text-primary bg-bg-surface"
			:aria-label="t('builder.richText.source')"
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
