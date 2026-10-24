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
 * Escape handling never closes it, to keep one owner for the key.
 *
 * `focus` decides whether the panel takes focus when it opens and gives it
 * back when it closes: to the `#trigger`, or without one to whatever had focus
 * when it opened. A press or focus outside that closes it leaves focus where
 * that went. A panel that takes focus is a dialog: Tab cycles
 * through it, an open `UiModal`'s Tab trap stands aside meanwhile (the panel
 * is outside the modal's DOM), and it is named by its `#trigger` or by
 * `label`. Suggestion lists turn focus off: the person keeps typing in the
 * field while the list follows, and a press in that field (`inside`) does not
 * count as outside. Such a panel is only a box around what the field controls
 * (a listbox), so it has no role and no name of its own.
 */
import { computed, useSlots } from 'vue';
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import { useEscapeLayer } from '../../composables/useEscapeLayer';
import { useFocusLayer } from '../../composables/useModalFocus';
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
		/** Names the panel when it takes focus and has no `#trigger` to name it. */
		label?: string;
	}>(),
	{
		anchor: null,
		side: 'bottom',
		align: 'start',
		sideOffset: 4,
		matchAnchorWidth: false,
		focus: true,
		inside: () => [],
		label: undefined,
	}
);

const open = defineModel<boolean>('open', { default: false });

defineSlots<{
	/** The element that opens and closes the panel (rendered as-is). */
	trigger?: () => unknown;
	default?: () => unknown;
}>();

const slots = useSlots();

useEscapeLayer(open, () => {
	open.value = false;
});
useFocusLayer(() => open.value && props.focus);

/**
 * Reka renders every panel as a dialog labelled by the trigger. That holds
 * for a focused panel with a trigger; without one the reference would point
 * at nothing, and a panel that never takes focus is no dialog at all. An
 * attribute set to `undefined` on the panel element overrides Reka's and is
 * left out.
 */
const semantics = computed(() => {
	if (!props.focus) return { role: undefined, 'aria-labelledby': undefined };
	if (props.label) return { 'aria-label': props.label, 'aria-labelledby': undefined };
	if (!slots['trigger']) return { 'aria-labelledby': undefined };
	return {};
});

/**
 * Reka closes the panel on any Escape that reaches its window listener unless
 * the key is cancelled, and cancelling a composing Escape breaks the IME's own
 * cancel. Every Escape that should close the panel is the escape layer's and
 * never reaches Reka, so a close Reka asks for in answer to an Escape is
 * dropped instead, and the key keeps its default. Reka asks synchronously
 * inside its listener, before the microtask that clears the flag.
 */
let escapeReached = false;

function onRekaEscape() {
	escapeReached = true;
	queueMicrotask(() => (escapeReached = false));
}

function onRekaOpen(next: boolean) {
	if (!next && escapeReached) return;
	open.value = next;
}

// Reka gives focus back only to its registered `#trigger`. Without one, the
// panel gives it back to its opener itself, unless the panel was closed by a
// press or focus outside: then focus belongs where that went.
let opener: HTMLElement | null = null;
let interactedOutside = false;

function onInteractOutside(event: Event) {
	const target = event.target as Node | null;
	if (target && props.inside.some((el) => el?.contains(target))) event.preventDefault();
	if (!event.defaultPrevented) interactedOutside = true;
}

function onOpenAutoFocus(event: Event) {
	const active = document.activeElement;
	opener = active instanceof HTMLElement && active !== document.body ? active : null;
	interactedOutside = false;
	if (!props.focus) event.preventDefault();
}

function onCloseAutoFocus(event: Event) {
	const restoreTo = !interactedOutside && opener?.isConnected ? opener : null;
	opener = null;
	interactedOutside = false;
	if (!props.focus) {
		event.preventDefault();
		return;
	}
	if (slots['trigger']) return;
	event.preventDefault();
	restoreTo?.focus();
}
</script>

<template>
	<PopoverRoot :open="open" @update:open="onRekaOpen">
		<PopoverTrigger v-if="$slots['trigger']" as-child>
			<slot name="trigger" />
		</PopoverTrigger>
		<PopoverPortal>
			<PopoverContent
				as-child
				:reference="anchor ?? undefined"
				:side="side"
				:align="align"
				:side-offset="sideOffset"
				:collision-padding="8"
				@escape-key-down="onRekaEscape"
				@interact-outside="onInteractOutside"
				@open-auto-focus="onOpenAutoFocus"
				@close-auto-focus="onCloseAutoFocus"
			>
				<div
					v-bind="{ ...$attrs, ...semantics }"
					class="ui-popover z-(--z-menu) max-h-(--reka-popover-content-available-height) overflow-y-auto rounded-lg border border-border-subtle bg-bg-elevated shadow-lg outline-none"
					:class="{ 'w-(--reka-popover-trigger-width)': matchAnchorWidth }"
				>
					<slot />
				</div>
			</PopoverContent>
		</PopoverPortal>
	</PopoverRoot>
</template>
