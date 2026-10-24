<script setup lang="ts">
/**
 * A panel anchored to something on the page: placed under it (or above it, or
 * on the side the caller asks for), flipped to the other side when the window
 * has no room there, kept inside the window, and rendered at the end of
 * `<body>` so no `overflow: hidden` ancestor clips it. Positioning, flipping
 * and outside-press dismissal are Reka UI's (`PopoverRoot`/`PopoverContent`).
 *
 * Anchor it either to the `#trigger` slot (a button that toggles it) or to an
 * `anchor`: an element, or a box with no element of its own such as a text
 * caret (`VirtualAnchor`, see `utils/popoverAnchor.ts`).
 *
 * Escape goes through `useEscapeLayer` while the panel is open, so inside a
 * modal the first Escape closes the panel and the second the modal. Reka's own
 * Escape handling is switched off to keep one owner for the key.
 *
 * `focus` decides whether the panel takes focus when it opens (and gives it
 * back when it closes). Suggestion lists turn it off: the person keeps typing
 * in the field while the list follows, and a press in that field (`inside`)
 * does not count as outside.
 */
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import { useEscapeLayer } from '../../composables/useEscapeLayer';
import type { PopoverAnchorTarget } from '../../utils/popoverAnchor';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
	defineProps<{
		/** What the panel hangs from when there is no `#trigger`. */
		anchor?: PopoverAnchorTarget | null;
		side?: 'top' | 'bottom' | 'left' | 'right';
		align?: 'start' | 'center' | 'end';
		/** Gap between the anchor and the panel, in px. */
		sideOffset?: number;
		/** Make the panel exactly as wide as its anchor. */
		matchAnchorWidth?: boolean;
		/** Move focus into the panel on open and back on close. */
		focus?: boolean;
		/** Elements a press may land on without closing the panel. */
		inside?: (Element | null | undefined)[];
	}>(),
	{
		anchor: null,
		side: 'bottom',
		align: 'start',
		sideOffset: 4,
		matchAnchorWidth: false,
		focus: true,
		inside: () => [],
	}
);

const open = defineModel<boolean>('open', { default: false });

defineSlots<{
	/** The element that opens and closes the panel (rendered as-is). */
	trigger?: () => unknown;
	default?: () => unknown;
}>();

useEscapeLayer(open, () => {
	open.value = false;
});

function onInteractOutside(event: Event) {
	const target = event.target as Node | null;
	if (target && props.inside.some((el) => el?.contains(target))) event.preventDefault();
}

function onAutoFocus(event: Event) {
	if (!props.focus) event.preventDefault();
}
</script>

<template>
	<PopoverRoot v-model:open="open">
		<PopoverTrigger v-if="$slots['trigger']" as-child>
			<slot name="trigger" />
		</PopoverTrigger>
		<PopoverPortal>
			<PopoverContent
				v-bind="$attrs"
				:reference="anchor ?? undefined"
				:side="side"
				:align="align"
				:side-offset="sideOffset"
				:collision-padding="8"
				class="ui-popover z-(--z-menu) max-h-(--reka-popover-content-available-height) overflow-y-auto rounded-lg border border-border-subtle bg-bg-elevated shadow-lg outline-none"
				:class="{ 'w-(--reka-popover-trigger-width)': matchAnchorWidth }"
				@escape-key-down.prevent
				@interact-outside="onInteractOutside"
				@open-auto-focus="onAutoFocus"
				@close-auto-focus="onAutoFocus"
			>
				<slot />
			</PopoverContent>
		</PopoverPortal>
	</PopoverRoot>
</template>
