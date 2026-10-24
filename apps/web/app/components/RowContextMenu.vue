<script setup lang="ts" generic="A extends RowSwipeAction = 'none'">
/**
 * A list row's context menu, opened by right-click on desktop and by a
 * long-press on touch, with an optional swipe on the same pointer stream.
 *
 * `UiContextMenu` owns the menu itself (focus trap, Escape, arrow keys, the
 * shortcut column) and `usePostboxRowGestures` owns the pointer stream (the
 * hold timer, the scroll-versus-swipe arbitration, the click the gesture must
 * swallow). This only joins the two, so every row that wants a menu gets the
 * same long-press and the same click suppression without re-wiring five
 * handlers per surface.
 *
 * The consumer binds `rowBindings` onto its own row element with `v-bind`,
 * which keeps the slot free of wrapper markup (safe inside `<ul>` and
 * `<tbody>`). A row with no swipe leaves `swipeLeft` / `swipeRight` unset and
 * never claims a horizontal drag; one that swipes renders `track` behind its
 * content and moves the content by `rowStyle`.
 */
import UiContextMenu, { type ContextMenuItem } from '@owlat/ui/components/ui/ContextMenu.vue';
import { usePostboxRowGestures } from '~/composables/postbox/usePostboxRowGestures';
import type { RowSwipeAction } from '~/utils/postboxSwipe';

const props = defineProps<{
	items: ContextMenuItem[] | (() => ContextMenuItem[]);
	/** The verb a leftward drag fires. Unset: the row does not swipe left. */
	swipeLeft?: A;
	/** The verb a rightward drag fires. */
	swipeRight?: A;
	/**
	 * Shift+click anywhere on the row emits `shift-click` instead of following
	 * the row's link, for rows that extend a selection from an anchor.
	 */
	shiftClickSelects?: boolean;
}>();

const emit = defineEmits<{
	swipe: [action: Exclude<A, 'none'>];
	'shift-click': [];
}>();

const gestures = usePostboxRowGestures<A | 'none'>({
	leftAction: () => props.swipeLeft ?? 'none',
	rightAction: () => props.swipeRight ?? 'none',
	onSwipe: (action) => emit('swipe', action as Exclude<A, 'none'>),
	// Re-dispatch the row's own `contextmenu` at the touch point, so the menu
	// opens through the same path a right-click takes.
	onLongPress: (row, point) =>
		row.dispatchEvent(
			new MouseEvent('contextmenu', {
				bubbles: true,
				cancelable: true,
				clientX: point.x,
				clientY: point.y,
			})
		),
});

/** Swallow the click a fired long-press or a swipe leaves behind. */
function onClickCapture(event: MouseEvent) {
	if (props.shiftClickSelects && event.shiftKey) {
		event.preventDefault();
		event.stopPropagation();
		emit('shift-click');
		return;
	}
	if (!gestures.consumeClickSuppression()) return;
	event.preventDefault();
	event.stopPropagation();
}

function bindingsFor(
	onContextmenu: (e: MouseEvent) => void,
	onKeydown: (e: KeyboardEvent) => void
) {
	return {
		onContextmenu,
		onKeydown,
		onPointerdown: gestures.onPointerdown,
		onPointermove: gestures.onPointermove,
		onPointerup: gestures.onPointerup,
		onPointercancel: gestures.onPointercancel,
		onClickCapture,
	};
}
</script>

<template>
	<UiContextMenu :items="items">
		<template #default="{ onContextmenu, onKeydown }">
			<slot
				:row-bindings="bindingsFor(onContextmenu, onKeydown)"
				:track="gestures.track.value"
				:settling="gestures.settling.value"
				:row-style="gestures.rowStyle.value"
			/>
		</template>
	</UiContextMenu>
</template>
