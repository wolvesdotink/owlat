/**
 * The touch verbs on a Postbox thread row: long-press for the context menu, and
 * swipe left/right to triage (UX plan idea 21).
 *
 * ONE composable for both because they are one pointer stream. A press and a
 * swipe start identically — finger down, nothing has happened yet — and the
 * first few pixels of movement decide which of them the gesture becomes (or
 * whether it is neither, and the list is simply being scrolled). Wiring them as
 * two independent handler sets meant two copies of the origin, two slop checks
 * and two answers to "should the click that follows still open the message";
 * here the arbitration is written once.
 *
 * The row binds five handlers and renders what `track` describes. All of the
 * geometry — the slop, the horizontal-dominance test, the commit distance, the
 * rubber band, the flick velocity — lives in `utils/postboxSwipe.ts` and is
 * unit-tested there without a DOM.
 *
 * THREE THINGS THIS MUST NOT BREAK, and how:
 *
 *  - The list's vertical scroll. A drag has to prove it is horizontal before it
 *    claims the pointer, and a drag that starts vertically is abandoned for the
 *    rest of that pointer rather than re-checked on every move. The row also
 *    carries `touch-action: pan-y`, so the browser keeps the vertical axis and
 *    hands us the horizontal one.
 *  - The row's NuxtLink. A claimed gesture sets a suppression flag that the
 *    row's capture-phase click handler consumes, so neither a fired long-press
 *    nor a swipe (committed OR sprung back) navigates afterwards.
 *  - The virtual list. The offset is a transform on the row's CONTENT, never on
 *    the `<li>` the windowing translates and measures, so row heights and the
 *    window's own `translateY` are untouched.
 *
 * Mouse pointers never reach any of this: `isSwipePointer` accepts touch and
 * pen only, and a desktop drag across a row stays a text selection.
 */

import { prefersReducedMotion } from '~/composables/useMediaQuery';
import {
	classifySwipeIntent,
	isSwipePointer,
	pruneSwipeSamples,
	resolveSwipeRelease,
	swipeSettleMs,
	swipeTrackState,
	swipeVelocity,
	type PostboxSwipeAction,
	type PostboxSwipeSample,
	type PostboxSwipeTrackState,
} from '~/utils/postboxSwipe';

/** How long a press has to be held before it opens the context menu. */
export const POSTBOX_LONG_PRESS_MS = 500;
/** Movement that turns a hold into a drag (scroll or swipe), so the hold stands down. */
export const POSTBOX_LONG_PRESS_SLOP_PX = 8;

export interface PostboxRowGestureOptions {
	/** The action a leftward drag fires, read fresh so a settings change lands live. */
	leftAction: () => PostboxSwipeAction;
	/** The action a rightward drag fires. */
	rightAction: () => PostboxSwipeAction;
	/** A committed swipe. The row emits; the list owns the mutation. */
	onSwipe: (action: Exclude<PostboxSwipeAction, 'none'>) => void;
	/** The hold fired: open the row's context menu at this point. */
	onLongPress: (row: HTMLElement, point: { x: number; y: number }) => void;
}

export function usePostboxRowGestures(options: PostboxRowGestureOptions) {
	/** The reveal track for the drag in progress; null at rest. */
	const track = shallowRef<PostboxSwipeTrackState | null>(null);
	/** True while the row is animating back after release (drives the transition). */
	const settling = ref(false);

	let pressTimer: ReturnType<typeof setTimeout> | null = null;
	let settleTimer: ReturnType<typeof setTimeout> | null = null;
	let origin: { x: number; y: number } | null = null;
	let row: HTMLElement | null = null;
	let pointerId: number | null = null;
	let intent: 'pending' | 'horizontal' | 'abandoned' = 'abandoned';
	let samples: PostboxSwipeSample[] = [];
	/**
	 * Set when a long-press fired or a swipe claimed the pointer, so the click
	 * the finger-lift synthesises does not also open the message.
	 */
	let suppressNextClick = false;

	function clearPressTimer() {
		if (pressTimer !== null) {
			clearTimeout(pressTimer);
			pressTimer = null;
		}
	}

	/** Forget the gesture without firing anything (cancel, teardown, abandon). */
	function resetGesture() {
		clearPressTimer();
		if (pointerId !== null && row?.hasPointerCapture?.(pointerId)) {
			row.releasePointerCapture(pointerId);
		}
		origin = null;
		pointerId = null;
		intent = 'abandoned';
		samples = [];
	}

	/**
	 * Animate the row back to rest and drop the track once it has arrived. Under
	 * `prefers-reduced-motion` the settle duration is zero: the row still follows
	 * the finger — direct manipulation IS the gesture — but nothing slides on its
	 * own afterwards. Read one-shot, at the moment of release, because that is
	 * when the decision is made.
	 */
	function settleBack() {
		const current = track.value;
		if (!current) return;
		const ms = swipeSettleMs(prefersReducedMotion());
		settling.value = true;
		track.value = { ...current, offsetPx: 0, progress: 0, armed: false };
		if (settleTimer !== null) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			settleTimer = null;
			track.value = null;
			settling.value = false;
		}, ms);
	}

	function onPointerdown(event: PointerEvent) {
		// Mice already own right-click and drag-select; secondary touch points in a
		// multi-touch gesture are not a swipe; taps on the row's own controls
		// (checkbox, quick actions) handle themselves.
		if (!isSwipePointer(event.pointerType) || !event.isPrimary) return;
		if ((event.target as HTMLElement | null)?.closest('button')) return;
		// A new press starts clean: the previous long-press's click may have been
		// swallowed by the menu's backdrop (dismissed by tapping outside, or Esc)
		// rather than reaching this row, which would otherwise leave the flag set
		// and eat the next legitimate tap.
		suppressNextClick = false;
		resetGesture();
		if (settleTimer !== null) {
			clearTimeout(settleTimer);
			settleTimer = null;
		}
		track.value = null;
		settling.value = false;
		origin = { x: event.clientX, y: event.clientY };
		row = event.currentTarget as HTMLElement;
		pointerId = event.pointerId;
		intent = 'pending';
		samples = [{ x: event.clientX, t: event.timeStamp }];
		const target = row;
		pressTimer = setTimeout(() => {
			pressTimer = null;
			if (!origin || intent !== 'pending') return;
			suppressNextClick = true;
			options.onLongPress(target, { x: origin.x, y: origin.y });
			// The hold consumed this pointer; a later drag must not also swipe.
			intent = 'abandoned';
		}, POSTBOX_LONG_PRESS_MS);
	}

	function onPointermove(event: PointerEvent) {
		if (!origin || event.pointerId !== pointerId) return;
		const dx = event.clientX - origin.x;
		const dy = event.clientY - origin.y;

		if (intent === 'pending') {
			// Any real movement is a drag, not a hold.
			if (Math.abs(dx) > POSTBOX_LONG_PRESS_SLOP_PX || Math.abs(dy) > POSTBOX_LONG_PRESS_SLOP_PX) {
				clearPressTimer();
			}
			const verdict = classifySwipeIntent(dx, dy);
			if (verdict === 'pending') return;
			if (verdict === 'abandoned') {
				// A scroll. Give the pointer back for good — re-testing it on every
				// move is how a flick down a long folder ends up archiving a row.
				resetGesture();
				return;
			}
			intent = 'horizontal';
			suppressNextClick = true;
			settling.value = false;
			// Keep receiving moves even if the finger leaves the row's box.
			row?.setPointerCapture?.(event.pointerId);
		}

		if (intent !== 'horizontal') return;
		// The browser owns the vertical axis (touch-action: pan-y); this stops it
		// from also treating the claimed horizontal drag as a text selection.
		event.preventDefault();
		samples = pruneSwipeSamples(
			[...samples, { x: event.clientX, t: event.timeStamp }],
			event.timeStamp
		);
		track.value = swipeTrackState({
			dx,
			leftAction: options.leftAction(),
			rightAction: options.rightAction(),
		});
	}

	function onPointerup(event: PointerEvent) {
		if (event.pointerId !== pointerId) {
			clearPressTimer();
			return;
		}
		const claimed = intent === 'horizontal';
		const dx = origin ? event.clientX - origin.x : 0;
		const velocitySamples = pruneSwipeSamples(
			[...samples, { x: event.clientX, t: event.timeStamp }],
			event.timeStamp
		);
		resetGesture();
		if (!claimed) return;
		const action = resolveSwipeRelease({
			dx,
			velocityX: swipeVelocity(velocitySamples),
			leftAction: options.leftAction(),
			rightAction: options.rightAction(),
		});
		settleBack();
		if (action) options.onSwipe(action);
	}

	function onPointercancel() {
		resetGesture();
		settleBack();
	}

	/**
	 * Did a gesture claim the click that is now arriving? Reading it consumes it,
	 * so exactly one click is swallowed per gesture.
	 */
	function consumeClickSuppression(): boolean {
		if (!suppressNextClick) return false;
		suppressNextClick = false;
		return true;
	}

	/** The row content's transform while a drag is in flight. */
	const rowStyle = computed(() =>
		track.value ? { transform: `translate3d(${track.value.offsetPx}px, 0, 0)` } : undefined
	);

	onUnmounted(() => {
		resetGesture();
		if (settleTimer !== null) clearTimeout(settleTimer);
	});

	return {
		track,
		settling,
		rowStyle,
		onPointerdown,
		onPointermove,
		onPointerup,
		onPointercancel,
		consumeClickSuppression,
	};
}
