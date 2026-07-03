<script setup lang="ts">
/**
 * Presentational snippet "/" picker overlay for {@link PostboxBasicEditor}.
 *
 * Pure chrome: the caret-anchored dropdown of ranked snippets. All trigger /
 * positioning / keyboard / insert logic lives in `usePostboxSnippetPicker`;
 * this component only renders the list and reports hover/click back up. Items
 * use `mousedown.prevent` so clicking one never blurs the editor first.
 */
import type { EditorSnippet } from '~/composables/postbox/usePostboxSnippetPicker';

defineProps<{
	items: EditorSnippet[];
	activeIndex: number;
	style: Record<string, string> | null;
}>();

const emit = defineEmits<{
	(e: 'select', item: EditorSnippet): void;
	(e: 'hover', index: number): void;
}>();
</script>

<template>
	<div
		v-if="style"
		class="postbox-snippet-picker absolute z-20 min-w-[220px] max-w-[320px] rounded-md border border-border-subtle bg-bg-elevated shadow-lg overflow-hidden"
		:style="style"
		role="listbox"
		aria-label="Snippets"
	>
		<div
			v-if="items.length === 0"
			class="px-3 py-2 text-xs text-text-tertiary"
		>
			No matching snippets
		</div>
		<button
			v-for="(item, i) in items"
			:key="item._id"
			type="button"
			role="option"
			:aria-selected="i === activeIndex"
			class="w-full text-left px-3 py-1.5 flex items-center justify-between gap-2 text-sm"
			:class="i === activeIndex ? 'bg-brand-subtle text-text-primary' : 'text-text-secondary hover:bg-bg-surface'"
			@mousedown.prevent="emit('select', item)"
			@mousemove="emit('hover', i)"
		>
			<span class="truncate">{{ item.name }}</span>
			<span
				v-if="item.shortcut"
				class="shrink-0 text-xs text-text-tertiary font-mono"
			>/{{ item.shortcut }}</span>
		</button>
	</div>
</template>
