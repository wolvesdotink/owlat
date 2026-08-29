<script setup lang="ts">
/**
 * The divider between the Postbox message list and the reader.
 *
 * A WAI-ARIA window splitter: `role="separator"` with `aria-valuenow` in the
 * same pixels the preference stores, so the seam is movable by pointer AND by
 * keyboard. The keyboard path is not a fallback bolted on afterwards — a drag
 * handle that only answers to a pointer is unusable with a trackpad tremor, a
 * switch device, or a screen reader, and this one is the only way to change a
 * geometry the user now owns.
 *
 *   - pointer  → drag; the size is derived from the pointer's distance past the
 *                list pane's own leading edge, so nothing drifts if the window
 *                resizes mid-drag.
 *   - arrows   → 16px per press, 64px with Shift (and on PageUp/PageDown).
 *   - Home/End → the axis minimum / maximum.
 *   - Enter    → back to the default width, an escape hatch from a seam dragged
 *                somewhere unusable.
 *
 * All the arithmetic lives in utils/postboxReadingPane; this component owns
 * only the events. `v-model` updates live during the drag (the layout follows
 * the pointer) while `commit` fires once on release — a settings mutation per
 * pointermove would be a write storm.
 */
import type { PostboxPaneAxis } from '~/utils/postboxReadingPane';
import {
	POSTBOX_LIST_SIZE_LIMITS,
	clampPostboxListSize,
	nudgePostboxListSize,
	postboxListSizeFromPointer,
	postboxListSizeStep,
} from '~/utils/postboxReadingPane';

const props = defineProps<{
	/** Which dimension of the list pane this divider moves. */
	axis: PostboxPaneAxis;
	/** Current size, in CSS pixels. */
	modelValue: number;
	/** The list pane, measured for the drag origin. */
	paneEl?: HTMLElement | null;
}>();

const emit = defineEmits<{
	'update:modelValue': [size: number];
	/** The size to persist, once, at the end of an interaction. */
	commit: [size: number];
}>();

const { t } = useI18n();

const limits = computed(() => POSTBOX_LIST_SIZE_LIMITS[props.axis]);
const dragging = ref(false);

/** The list pane's leading edge on the resized axis. */
function paneOrigin(): number | null {
	const rect = props.paneEl?.getBoundingClientRect();
	if (!rect) return null;
	return props.axis === 'width' ? rect.left : rect.top;
}

function applyLive(size: number) {
	if (size !== props.modelValue) emit('update:modelValue', size);
}

function onPointerMove(event: PointerEvent) {
	const origin = paneOrigin();
	if (origin === null) return;
	const pointer = props.axis === 'width' ? event.clientX : event.clientY;
	applyLive(postboxListSizeFromPointer(pointer, origin, props.axis));
}

function endDrag() {
	if (!dragging.value) return;
	dragging.value = false;
	window.removeEventListener('pointermove', onPointerMove);
	window.removeEventListener('pointerup', endDrag);
	window.removeEventListener('pointercancel', endDrag);
	emit('commit', clampPostboxListSize(props.modelValue, props.axis));
}

function onPointerDown(event: PointerEvent) {
	// Primary button / single touch only: a right-click or a second finger
	// mid-drag must not start a second, competing resize.
	if (event.button !== 0) return;
	event.preventDefault();
	dragging.value = true;
	window.addEventListener('pointermove', onPointerMove);
	window.addEventListener('pointerup', endDrag);
	window.addEventListener('pointercancel', endDrag);
}

onBeforeUnmount(endDrag);

/** Double-click restores the default — the same escape hatch Enter offers. */
function onDoubleClick() {
	const next = limits.value.default;
	applyLive(next);
	emit('commit', next);
}

function onKeydown(event: KeyboardEvent) {
	// Which direction grows the list depends on the axis: for a vertical
	// divider that is ArrowRight, for a horizontal one ArrowDown.
	const grow = props.axis === 'width' ? 'ArrowRight' : 'ArrowDown';
	const shrink = props.axis === 'width' ? 'ArrowLeft' : 'ArrowUp';
	let next: number | null = null;
	if (event.key === grow) next = nudge(postboxListSizeStep(event.shiftKey));
	else if (event.key === shrink) next = nudge(-postboxListSizeStep(event.shiftKey));
	else if (event.key === 'PageDown') next = nudge(postboxListSizeStep(true));
	else if (event.key === 'PageUp') next = nudge(-postboxListSizeStep(true));
	else if (event.key === 'Home') next = limits.value.min;
	else if (event.key === 'End') next = limits.value.max;
	else if (event.key === 'Enter') next = limits.value.default;
	if (next === null) return;
	event.preventDefault();
	applyLive(next);
	// A key press is a complete interaction: persist it. Held arrows coalesce
	// naturally — each write patches one field with the newest value.
	emit('commit', next);
}

function nudge(delta: number): number {
	return nudgePostboxListSize(props.modelValue, delta, props.axis);
}
</script>

<template>
	<!-- Hidden below `lg`: the narrow layout is a stacked drill-in with no seam
	     to move. The hit area is wider than the 1px line it paints (the rule is
	     the neighbouring pane's border), which is what makes it grabbable. -->
	<div
		role="separator"
		tabindex="0"
		:aria-orientation="axis === 'width' ? 'vertical' : 'horizontal'"
		:aria-label="t('components.postbox.postboxPaneResizer.label')"
		:aria-valuenow="modelValue"
		:aria-valuemin="limits.min"
		:aria-valuemax="limits.max"
		:aria-valuetext="t('components.postbox.postboxPaneResizer.valueText', { size: modelValue })"
		class="hidden lg:block relative z-10 flex-shrink-0 outline-none group focus-visible:ring-1 focus-visible:ring-brand/50"
		:class="[
			axis === 'width' ? 'w-1.5 -mx-0.75 cursor-col-resize' : 'h-1.5 -my-0.75 cursor-row-resize',
			dragging ? 'bg-brand/40' : 'hover:bg-brand/20',
		]"
		@pointerdown="onPointerDown"
		@dblclick="onDoubleClick"
		@keydown="onKeydown"
	/>
</template>
