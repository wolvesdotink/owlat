<script setup lang="ts">
/**
 * Formatting toolbar for {@link PostboxBasicEditor} (B / I / U, H1–H2, bullet &
 * ordered lists, blockquote, link).
 *
 * Pure presentation: it reflects the editor's current `activeMarks` and emits a
 * typed command per button. The parent owns the actual `useRichText` mutations
 * and re-focuses the contenteditable first (buttons keep `@mousedown.prevent`
 * so a click never steals the selection). Extracted from the editor SFC to keep
 * it under the file-size ratchet.
 */

import { computed } from 'vue';
import type { ActiveMarks } from '@owlat/ui/composables/useRichText';

const props = withDefaults(
	defineProps<{
		activeMarks: ActiveMarks;
		/**
		 * `persistent` = the classic full-width bar bolted to the top of the editor
		 * (border + surface background). `floating` = the format section embedded in
		 * a floating bar that supplies its own chrome, so the toolbar stays neutral.
		 */
		variant?: 'persistent' | 'floating';
	}>(),
	{ variant: 'persistent' },
);

const containerClass = computed(() =>
	props.variant === 'floating'
		? 'flex items-center gap-0.5'
		: 'flex items-center gap-0.5 px-1 py-1 border-b border-border-subtle bg-bg-surface',
);

const emit = defineEmits<{
	(e: 'bold'): void;
	(e: 'italic'): void;
	(e: 'underline'): void;
	(e: 'heading', level: 1 | 2): void;
	(e: 'list', ordered: boolean): void;
	(e: 'blockquote'): void;
	(e: 'link'): void;
}>();
</script>

<template>
	<div :class="containerClass">
		<button
			type="button"
			class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
			:class="{ 'bg-bg-elevated text-brand': activeMarks.bold }"
			title="Bold (⌘B)"
			@mousedown.prevent
			@click="emit('bold')"
		>
			<Icon name="lucide:bold" class="w-4 h-4" />
		</button>
		<button
			type="button"
			class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
			:class="{ 'bg-bg-elevated text-brand': activeMarks.italic }"
			title="Italic (⌘I)"
			@mousedown.prevent
			@click="emit('italic')"
		>
			<Icon name="lucide:italic" class="w-4 h-4" />
		</button>
		<button
			type="button"
			class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
			:class="{ 'bg-bg-elevated text-brand': activeMarks.underline }"
			title="Underline (⌘U)"
			@mousedown.prevent
			@click="emit('underline')"
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
			@click="emit('heading', 1)"
		>
			<Icon name="lucide:heading-1" class="w-4 h-4" />
		</button>
		<button
			type="button"
			class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
			:class="{ 'bg-bg-elevated text-brand': activeMarks.h2 }"
			title="Heading 2"
			@mousedown.prevent
			@click="emit('heading', 2)"
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
			@click="emit('list', false)"
		>
			<Icon name="lucide:list" class="w-4 h-4" />
		</button>
		<button
			type="button"
			class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
			:class="{ 'bg-bg-elevated text-brand': activeMarks.ol }"
			title="Ordered list"
			@mousedown.prevent
			@click="emit('list', true)"
		>
			<Icon name="lucide:list-ordered" class="w-4 h-4" />
		</button>
		<button
			type="button"
			class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
			:class="{ 'bg-bg-elevated text-brand': activeMarks.quote }"
			title="Blockquote"
			@mousedown.prevent
			@click="emit('blockquote')"
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
			@click="emit('link')"
		>
			<Icon name="lucide:link" class="w-4 h-4" />
		</button>
	</div>
</template>
