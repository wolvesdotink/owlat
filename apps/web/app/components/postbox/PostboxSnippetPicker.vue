<script setup lang="ts">
/**
 * The saved-reply `;` suggestions at the caret, for {@link PostboxBasicEditor}
 * and the Team inbox reply's textarea.
 *
 * Pure chrome over the shared `UiSuggestionPopover`: the list of ranked
 * replies, its highlight and keys (↑ ↓, Enter or Tab inserts, Esc dismisses).
 * Trigger detection, ranking and insertion stay in the host's controller
 * (`usePostboxSnippetPicker`, `useTeamComposerSavedReplies`), which forwards
 * the field's keydown to `handleKeydown` first and spreads `fieldAttrs` on
 * it. The field keeps focus throughout, so a click inserts at the caret.
 */
import type { SuggestionListHandle } from '@owlat/ui/utils/listboxField';
import type { PopoverAnchorTarget } from '@owlat/ui/utils/popoverAnchor';
import type { EditorSnippet } from '~/composables/postbox/usePostboxSnippetPicker';

defineProps<{
	items: EditorSnippet[];
	/** The caret box (or the field) the list hangs from. */
	anchor: PopoverAnchorTarget | null;
	/** The field being typed into. */
	field: HTMLElement | null;
}>();

const emit = defineEmits<{
	(e: 'select', item: EditorSnippet): void;
	/** Escape or a press elsewhere: stay closed until the `;token` changes. */
	(e: 'dismiss'): void;
}>();

const { t } = useI18n();

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
		:option-key="(item: EditorSnippet) => item._id"
		:label="t('components.postbox.postboxSnippetPicker.listLabel')"
		:anchor="anchor"
		:field="field"
		class="postbox-snippet-picker min-w-[220px] max-w-[320px] rounded-md"
		option-class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-text-secondary data-highlighted:bg-brand-subtle data-highlighted:text-text-primary"
		@select="(item: EditorSnippet) => emit('select', item)"
		@update:open="(open: boolean) => !open && emit('dismiss')"
	>
		<template #option="{ option }">
			<span class="truncate">{{ option.name }}</span>
			<span class="flex shrink-0 items-center gap-1.5">
				<Icon
					v-if="option.isShared"
					name="lucide:users"
					class="size-3 text-text-tertiary"
					:aria-label="t('shared.savedReplies.sharedBadge')"
				/>
				<span v-if="option.shortcut" class="text-xs text-text-tertiary font-mono"
					>;{{ option.shortcut }}</span
				>
			</span>
		</template>
	</UiSuggestionPopover>
</template>
