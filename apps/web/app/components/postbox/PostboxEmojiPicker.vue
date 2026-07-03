<script setup lang="ts">
/**
 * Compact inline `:shortcode:` emoji picker popover for {@link PostboxBasicEditor}.
 *
 * Pure chrome: the trigger detection, fuzzy filtering, caret placement, and
 * insertion all live in `usePostboxEmojiPicker`. This component only renders the
 * fuzzy-matched list at the supplied caret-anchored position and reports hover /
 * click intent. `mousedown.prevent` keeps focus in the editor so a click inserts
 * without collapsing the selection first.
 */
import type { PostboxEmoji } from '~/utils/postboxEmojiShortcodes';

const props = defineProps<{
	items: readonly PostboxEmoji[];
	activeIndex: number;
	/** Caret-anchored absolute position within the editor surface. */
	barStyle: Record<string, string> | null;
}>();

const emit = defineEmits<{
	(e: 'select', index: number): void;
	(e: 'hover', index: number): void;
}>();

// Keep the arrow-selected option visible once the list scrolls past its max-height.
const optionEls = ref<HTMLButtonElement[]>([]);
watch(
	() => props.activeIndex,
	(index) => {
		void nextTick(() => optionEls.value[index]?.scrollIntoView({ block: 'nearest' }));
	},
);
</script>

<template>
	<div
		v-if="barStyle && items.length"
		class="postbox-emoji-picker absolute z-30 max-h-56 w-64 overflow-y-auto rounded-lg border border-border-subtle bg-bg-elevated py-1 shadow-lg"
		:style="barStyle"
		role="listbox"
		aria-label="Emoji"
		@mousedown.prevent
	>
		<button
			v-for="(emoji, index) in items"
			:key="emoji.shortcode"
			ref="optionEls"
			type="button"
			role="option"
			:aria-selected="index === activeIndex"
			class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm"
			:class="index === activeIndex ? 'bg-bg-subtle' : 'hover:bg-bg-subtle'"
			@mousemove="emit('hover', index)"
			@click="emit('select', index)"
		>
			<span class="w-5 shrink-0 text-center text-base leading-none">{{ emoji.char }}</span>
			<span class="truncate text-text-secondary">:{{ emoji.shortcode }}:</span>
		</button>
	</div>
</template>
