<script setup lang="ts">
/**
 * Postbox basic rich-text editor.
 *
 * `contenteditable` + Selection/Range plumbing shared with the campaign
 * builder via `useRichText` in @owlat/ui. Toolbar covers B / I / U, H1-H2,
 * bullet & ordered lists, blockquote, link. v-models raw HTML.
 *
 * For richer compositions (heroes, columns, tables, …) the composer's
 * "Designer" mode mounts the full @owlat/email-builder instead.
 *
 * The empty document is normalized to `<p><br></p>` so the cursor always
 * lives inside a real paragraph (avoids browser-quirky wrapping on first
 * keystroke).
 */

import {
	useRichText,
	EMPTY_ACTIVE_MARKS,
	type ActiveMarks,
} from '@owlat/ui/composables/useRichText';

const props = defineProps<{
	modelValue: string;
	placeholder?: string;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: string): void;
}>();

const editorRef = ref<HTMLDivElement | null>(null);
const isEmpty = ref(true);
const activeMarks = ref<ActiveMarks>({ ...EMPTY_ACTIVE_MARKS });

const richText = useRichText({
	editorRef,
	onChange: () => emitContent(),
});

const {
	toggleBold,
	toggleItalic,
	toggleUnderline,
	toggleHeading,
	toggleBlockquote,
	toggleList,
	setLink,
	pasteAsPlainText,
	handleFormatKeydown,
	readActiveMarks,
} = richText;

function syncActiveMarks() {
	activeMarks.value = readActiveMarks();
}

function syncEmptyState() {
	const el = editorRef.value;
	if (!el) {
		isEmpty.value = true;
		return;
	}
	const text = el.innerText.replace(/​/g, '').trim();
	isEmpty.value = text.length === 0;
}

function ensureScaffold() {
	const el = editorRef.value;
	if (!el) return;
	if (el.childNodes.length === 0) {
		el.innerHTML = '<p><br></p>';
	}
}

function emitContent() {
	const el = editorRef.value;
	if (!el) return;
	emit('update:modelValue', el.innerHTML);
	syncEmptyState();
	syncActiveMarks();
}

function onKeydown(event: KeyboardEvent) {
	handleFormatKeydown(event);
}

function onPaste(event: ClipboardEvent) {
	pasteAsPlainText(event);
}

function onSelectionChange() {
	if (richText.getSelection()) syncActiveMarks();
}

function focusEditor() {
	editorRef.value?.focus();
}

// Toolbar buttons must not steal focus from the editor — `mousedown.prevent`
// in the template handles that. Define guarded handlers that re-focus first.
function withFocus(fn: () => void | Promise<void>) {
	return () => {
		focusEditor();
		void fn();
	};
}

onMounted(() => {
	const el = editorRef.value;
	if (el) {
		if (props.modelValue && el.innerHTML !== props.modelValue) {
			el.innerHTML = props.modelValue;
		} else {
			ensureScaffold();
		}
	}
	syncEmptyState();
	syncActiveMarks();
	document.addEventListener('selectionchange', onSelectionChange);
});

onBeforeUnmount(() => {
	document.removeEventListener('selectionchange', onSelectionChange);
});

watch(
	() => props.modelValue,
	(value) => {
		const el = editorRef.value;
		if (!el) return;
		if (el.innerHTML === value) return;
		const isFocused = document.activeElement === el;
		if (isFocused) return; // don't clobber the user's cursor mid-typing
		el.innerHTML = value || '';
		ensureScaffold();
		syncEmptyState();
	}
);

defineExpose({ focus: focusEditor });
</script>

<template>
	<div class="flex flex-col h-full">
		<div
			class="flex items-center gap-0.5 px-1 py-1 border-b border-border-subtle bg-bg-surface"
		>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.bold }"
				title="Bold (⌘B)"
				@mousedown.prevent
				@click="withFocus(toggleBold)()"
			>
				<Icon name="lucide:bold" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.italic }"
				title="Italic (⌘I)"
				@mousedown.prevent
				@click="withFocus(toggleItalic)()"
			>
				<Icon name="lucide:italic" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.underline }"
				title="Underline (⌘U)"
				@mousedown.prevent
				@click="withFocus(toggleUnderline)()"
			>
				<Icon name="lucide:underline" class="w-4 h-4" />
			</button>
			<span class="w-px h-4 bg-border-subtle mx-1" />
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.h1 }"
				title="Heading 1"
				@mousedown.prevent
				@click="withFocus(() => toggleHeading(1))()"
			>
				<Icon name="lucide:heading-1" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.h2 }"
				title="Heading 2"
				@mousedown.prevent
				@click="withFocus(() => toggleHeading(2))()"
			>
				<Icon name="lucide:heading-2" class="w-4 h-4" />
			</button>
			<span class="w-px h-4 bg-border-subtle mx-1" />
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.ul }"
				title="Bullet list"
				@mousedown.prevent
				@click="withFocus(() => toggleList(false))()"
			>
				<Icon name="lucide:list" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.ol }"
				title="Ordered list"
				@mousedown.prevent
				@click="withFocus(() => toggleList(true))()"
			>
				<Icon name="lucide:list-ordered" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.quote }"
				title="Blockquote"
				@mousedown.prevent
				@click="withFocus(toggleBlockquote)()"
			>
				<Icon name="lucide:quote" class="w-4 h-4" />
			</button>
			<span class="w-px h-4 bg-border-subtle mx-1" />
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.link }"
				title="Link (⌘K)"
				@mousedown.prevent
				@click="withFocus(setLink)()"
			>
				<Icon name="lucide:link" class="w-4 h-4" />
			</button>
		</div>
		<div class="flex-1 overflow-auto relative">
			<div
				ref="editorRef"
				role="textbox"
				aria-multiline="true"
				contenteditable="true"
				spellcheck="true"
				class="postbox-basic-editor outline-none p-3 min-h-full"
				@input="emitContent"
				@keydown="onKeydown"
				@paste="onPaste"
				@blur="emitContent"
			/>
			<div
				v-if="isEmpty"
				class="absolute top-3 left-3 text-text-tertiary text-sm pointer-events-none select-none"
			>
				{{ placeholder ?? 'Write your message…' }}
			</div>
		</div>
	</div>
</template>

<style scoped>
.postbox-basic-editor {
	font-size: 14px;
	line-height: 1.55;
	color: var(--color-text-primary, #1a1a1a);
}
.postbox-basic-editor :deep(h1) {
	font-size: 1.5rem;
	font-weight: 600;
	margin: 0.5em 0 0.3em;
}
.postbox-basic-editor :deep(h2) {
	font-size: 1.25rem;
	font-weight: 600;
	margin: 0.5em 0 0.3em;
}
.postbox-basic-editor :deep(p) {
	margin: 0 0 0.6em;
}
.postbox-basic-editor :deep(ul) {
	list-style: disc;
	padding-left: 1.5em;
	margin: 0 0 0.6em;
}
.postbox-basic-editor :deep(ol) {
	list-style: decimal;
	padding-left: 1.5em;
	margin: 0 0 0.6em;
}
.postbox-basic-editor :deep(blockquote) {
	border-left: 3px solid var(--color-border-subtle, #ddd);
	padding-left: 0.75em;
	color: var(--color-text-secondary, #555);
	margin: 0 0 0.6em;
}
.postbox-basic-editor :deep(a) {
	color: var(--color-brand, #0a6cdd);
	text-decoration: underline;
}
</style>
