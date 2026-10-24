<script setup lang="ts" generic="T">
/**
 * Suggestions for what is being typed into a text field: `@`-mentions in a
 * textarea, saved replies or emoji at the caret of a rich editor. The field
 * keeps focus and its caret the whole time; this is the one adapter between
 * such a field and the shared popover and listbox.
 *
 * The host detects the trigger, ranks the options and inserts the pick (that
 * is all domain logic); it opens this with `open` and an `anchor` (the field,
 * or a caret box from `utils/popoverAnchor.ts`), forwards the field's keydown
 * to `handleKeydown` first, and spreads `fieldAttrs` on the field so assistive
 * technology hears the highlighted option. ↑ ↓ move the highlight (wrapping),
 * Enter or Tab picks it, Escape closes (through the popover's escape layer,
 * ahead of any dialog the field sits in). An option is always highlighted, so
 * Enter always picks something.
 *
 * `update:open` with `false` means the person dismissed the list (Escape, a
 * press outside the field): the host should stop offering until the trigger
 * changes.
 */
import { computed, shallowRef, provide, type ShallowRef } from 'vue';
import UiListbox from './Listbox.vue';
import UiPopover from './Popover.vue';
import { LISTBOX_FIELD_HOST, type DrivenListbox } from '../../utils/listboxField';
import type { PopoverAnchorTarget } from '../../utils/popoverAnchor';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
	defineProps<{
		open: boolean;
		options: readonly T[];
		optionKey: (option: T) => string;
		/** Names the list for assistive technology. */
		label: string;
		/** The field, or a box (the caret) the list hangs from. */
		anchor: PopoverAnchorTarget | null;
		/** The field being typed into: a press there does not close the list. */
		field?: Element | null;
		side?: 'top' | 'bottom';
		/** As wide as the anchor (a list over the whole field). */
		matchAnchorWidth?: boolean;
		optionClass?: string;
	}>(),
	{ field: null, side: 'bottom', matchAnchorWidth: false, optionClass: '' }
);

const emit = defineEmits<{
	select: [option: T];
	'update:open': [open: boolean];
}>();

defineSlots<{
	option?: (props: { option: T; highlighted: boolean; selected: boolean }) => unknown;
	/** Above the options (a hint, a heading). */
	header?: () => unknown;
}>();

const list: ShallowRef<DrivenListbox | null> = shallowRef(null);
provide(LISTBOX_FIELD_HOST, { list });

const shown = computed(() => props.open && props.options.length > 0 && props.anchor !== null);

/** The field's keydown, first: true when the list took the key. */
function handleKeydown(event: KeyboardEvent): boolean {
	if (!shown.value) return false;
	return list.value?.handleKeydown(event, { tab: true }) ?? false;
}

/**
 * ARIA for the field: it controls the list and names the highlighted option.
 * No `aria-expanded`: the fields this serves are textboxes (a textarea, a
 * contenteditable), where only a combobox may carry it.
 */
const fieldAttrs = computed(() => ({
	'aria-autocomplete': 'list' as const,
	'aria-controls': shown.value ? list.value?.listId.value : undefined,
	'aria-activedescendant': shown.value ? list.value?.activeDescendant.value : undefined,
}));

defineExpose({ handleKeydown, fieldAttrs });
</script>

<template>
	<UiPopover
		v-bind="$attrs"
		:open="shown"
		:anchor="anchor"
		:side="side"
		:focus="false"
		:inside="[field]"
		:match-anchor-width="matchAnchorWidth"
		@update:open="emit('update:open', $event)"
	>
		<slot name="header" />
		<UiListbox
			:options="options"
			:option-key="optionKey"
			:label="label"
			loop
			auto-highlight
			:option-class="optionClass"
			@select="emit('select', $event)"
		>
			<template v-if="$slots['option']" #option="scope">
				<slot name="option" v-bind="scope" />
			</template>
		</UiListbox>
	</UiPopover>
</template>
