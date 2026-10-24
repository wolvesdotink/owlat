<script setup lang="ts">
/**
 * Compact inline `:shortcode:` emoji suggestions at the caret, for
 * {@link PostboxBasicEditor}.
 *
 * Pure chrome over the shared `UiSuggestionPopover`: the trigger detection,
 * fuzzy filtering and insertion live in `usePostboxEmojiPicker`, which
 * forwards the editor's keydown to `handleKeydown` first (the editor spreads
 * `fieldAttrs`). The editor keeps focus, so a click inserts without
 * collapsing the selection first.
 */
import type { SuggestionListHandle } from '@owlat/ui/utils/listboxField';
import type { PopoverAnchorTarget } from '@owlat/ui/utils/popoverAnchor';
import type { PostboxEmoji } from '~/utils/postboxEmojiData';

const { t } = useI18n();

defineProps<{
	items: readonly PostboxEmoji[];
	/** The caret box the list hangs from. */
	anchor: PopoverAnchorTarget | null;
	/** The editor being typed into. */
	field: HTMLElement | null;
}>();

const emit = defineEmits<{
	(e: 'select', emoji: PostboxEmoji): void;
	/** Escape or a press elsewhere: leave the literal `:sm` text as typed. */
	(e: 'dismiss'): void;
}>();

const popover = ref<SuggestionListHandle | null>(null);

defineExpose({
	handleKeydown: (event: KeyboardEvent) => popover.value?.handleKeydown(event) ?? false,
	fieldAttrs: computed(() => popover.value?.fieldAttrs ?? {}),
});
</script>

<template>
	<UiSuggestionPopover
		ref="popover"
		:open="items.length > 0"
		:options="items"
		:option-key="(emoji: PostboxEmoji) => emoji.shortcode"
		:label="t('components.postbox.postboxEmojiPicker.listLabel')"
		:anchor="anchor"
		:field="field"
		class="postbox-emoji-picker max-h-56 w-64 py-1"
		option-class="flex items-center gap-2 px-2.5 py-1.5 text-sm data-highlighted:bg-bg-subtle"
		@select="(emoji: PostboxEmoji) => emit('select', emoji)"
		@update:open="(open: boolean) => !open && emit('dismiss')"
	>
		<template #option="{ option }">
			<span class="w-5 shrink-0 text-center text-base leading-none">{{ option.char }}</span>
			<span class="truncate text-text-secondary">:{{ option.shortcode }}:</span>
		</template>
	</UiSuggestionPopover>
</template>
