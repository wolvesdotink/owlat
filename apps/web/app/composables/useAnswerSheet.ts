/**
 * Answer mode's reply sheet below 1100px: its height, the drag on its handle,
 * the handle's keys, and the sync with the phone's Conversation / Reply tabs.
 *
 * The rules (which height a tap, a key, a flick or a tab leads to) are the
 * pure functions in `utils/answerModeLayout.ts`; this is the wiring: pointer
 * capture on the handle, the live height while dragging, and the two-way tab
 * sync. It measures the body and the handle row on pointerdown, so nothing is
 * measured while nobody drags.
 */
import type { Ref } from 'vue';
import {
	ANSWER_PHONE_QUERY,
	ANSWER_SPLIT_QUERY,
	answerLayoutFor,
	clampSheetHeight,
	initialSheet,
	sheetForTab,
	snapSheet,
	stepSheet,
	tabForSheet,
	toggleSheet,
	type AnswerLayout,
	type AnswerSheetState,
	type AnswerTab,
} from '~/utils/answerModeLayout';
import { useMediaQuery } from '~/composables/useMediaQuery';

/** Movement under this many px is a tap on the handle, not a drag. */
const DRAG_SLOP = 6;

export function useAnswerLayout(): Readonly<Ref<AnswerLayout>> {
	const phone = useMediaQuery(ANSWER_PHONE_QUERY);
	const split = useMediaQuery(ANSWER_SPLIT_QUERY);
	return computed(() => answerLayoutFor({ phone: phone.value, split: split.value }));
}

export function useAnswerSheet(options: {
	tab: Ref<AnswerTab>;
	layout: Readonly<Ref<AnswerLayout>>;
	/** The frame's body (the sheet's container). */
	body: Readonly<Ref<HTMLElement | null>>;
	/** The sheet itself. */
	sheet: Readonly<Ref<HTMLElement | null>>;
	/** The handle row, whose height is the peek height. */
	handle: Readonly<Ref<HTMLElement | null>>;
}) {
	const { tab, layout } = options;
	const state = ref<AnswerSheetState>(initialSheet(layout.value, tab.value));
	/** The sheet's height in px while a finger or pointer drags it, else null. */
	const dragHeight = ref<number | null>(null);

	function syncTab() {
		if (layout.value === 'split') return;
		const next = tabForSheet(state.value, layout.value);
		if (tab.value !== next) tab.value = next;
	}

	watch(tab, (next) => {
		if (layout.value === 'split') return;
		state.value = sheetForTab(next, layout.value, state.value);
	});
	watch(state, syncTab);
	watch(layout, (next) => {
		state.value = initialSheet(next, tab.value);
		syncTab();
	});
	syncTab();

	function set(next: AnswerSheetState) {
		state.value = next;
	}

	let startY = 0;
	let startHeight = 0;
	let containerHeight = 0;
	let peekHeight = 0;
	let lastY = 0;
	let lastTime = 0;
	let velocity = 0;
	let pointerId: number | null = null;
	/** Set when a drag ends; the click that follows it is not a tap. */
	let swallowClick = false;

	function onPointerDown(event: PointerEvent) {
		if (event.button !== 0 || layout.value === 'split') return;
		const body = options.body.value;
		const sheet = options.sheet.value;
		if (!body || !sheet) return;
		pointerId = event.pointerId;
		startY = lastY = event.clientY;
		lastTime = event.timeStamp;
		velocity = 0;
		startHeight = sheet.getBoundingClientRect().height;
		containerHeight = body.getBoundingClientRect().height;
		peekHeight = options.handle.value?.getBoundingClientRect().height ?? 0;
		(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
	}

	function onPointerMove(event: PointerEvent) {
		if (pointerId !== event.pointerId) return;
		const moved = startY - event.clientY;
		if (dragHeight.value === null && Math.abs(moved) < DRAG_SLOP) return;
		const elapsed = event.timeStamp - lastTime;
		if (elapsed > 0) velocity = (lastY - event.clientY) / elapsed;
		lastY = event.clientY;
		lastTime = event.timeStamp;
		dragHeight.value = clampSheetHeight(startHeight + moved, containerHeight, peekHeight);
	}

	function onPointerUp(event: PointerEvent) {
		if (pointerId !== event.pointerId) return;
		pointerId = null;
		(event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
		if (dragHeight.value === null) return;
		swallowClick = true;
		// The click, if the browser sends one, comes before any timer runs.
		setTimeout(() => {
			swallowClick = false;
		}, 0);
		// A pause before letting go is not a flick.
		const stale = event.timeStamp - lastTime > 120;
		state.value = snapSheet({
			layout: layout.value,
			height: dragHeight.value,
			containerHeight,
			peekHeight,
			velocity: stale ? 0 : velocity,
		});
		dragHeight.value = null;
	}

	function onPointerCancel(event: PointerEvent) {
		if (pointerId !== event.pointerId) return;
		pointerId = null;
		dragHeight.value = null;
	}

	/**
	 * Capture-phase click on the handle row: the click a drag ends in lands on
	 * whatever button the drag started on (the grip, "Reply to …"), and must
	 * not also act as a tap.
	 */
	function onClickCapture(event: MouseEvent) {
		if (!swallowClick) return;
		swallowClick = false;
		event.preventDefault();
		event.stopPropagation();
	}

	function onHandleClick() {
		state.value = toggleSheet(state.value);
	}

	function onHandleKeydown(event: KeyboardEvent) {
		const direction = event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : null;
		if (!direction) return;
		event.preventDefault();
		state.value = stepSheet(state.value, direction);
	}

	return {
		state: readonly(state),
		dragHeight: readonly(dragHeight),
		set,
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onPointerCancel,
		onClickCapture,
		onHandleClick,
		onHandleKeydown,
	};
}
