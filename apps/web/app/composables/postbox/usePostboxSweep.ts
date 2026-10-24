/**
 * Sweep a range of Postbox rows with one press: hold a row's checkbox or hover
 * Archive button, drag across the rows, release to select (or deselect) or
 * archive every row covered. Esc cancels while the button is still down.
 *
 * Nothing is applied until release. While the pointer moves, `markOf` paints
 * the pending result on each covered row and `status` feeds the count pill; the
 * selection and the mail stay untouched, so a cancelled sweep has nothing to
 * roll back.
 *
 * The press arrives on a row; everything after it is tracked on `window`, so
 * the drag keeps working when the pointer leaves the row, the list or the
 * window. The range is resolved against the list's whole row order, not the
 * rows the windowed list happens to have mounted.
 *
 * THREE THINGS THIS MUST NOT BREAK, and how:
 *
 *  - The plain click. A press that never moves past the start distance is not
 *    a sweep: no listener eats anything, and the checkbox toggles or the row
 *    archives exactly as before.
 *  - The click a sweep leaves behind. Releasing after a sweep (or after Esc)
 *    still produces a click on whatever the pointer started and ended over; it
 *    is swallowed once, so a sweep never also toggles its last checkbox or
 *    opens a message.
 *  - Shift+click, touch swipes and long-press. A sweep starts from a plain
 *    primary mouse press only (`isPostboxSweepPress`).
 */

import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import {
	POSTBOX_SWEEP_START_PX,
	isPostboxSweepPress,
	postboxSweepMark,
	postboxSweepRange,
	postboxSweepRowAtY,
	type PostboxSweepKind,
	type PostboxSweepMark,
} from '~/utils/postboxSweep';

/** A finished sweep, handed to the owner to apply. */
export interface PostboxSweepCommit {
	mark: PostboxSweepMark;
	originId: string;
	/** The covered rows the action applies to, in list order. */
	ids: string[];
}

export interface PostboxSweepOptions {
	/**
	 * Every loaded row id in display order, read fresh on each move. Reactive:
	 * a change that alters the covered range mid-sweep cancels the sweep.
	 */
	orderedIds: () => readonly string[];
	/** The element whose `[data-sweep-row]` descendants are the rendered rows. */
	listEl: () => HTMLElement | null | undefined;
	/** Whether the row a checkbox sweep starts on is currently selected. */
	isSelected: (id: string) => boolean;
	/** Whether `mark` applies to row `id` in a sweep that started on `originId`. */
	canApply?: (mark: PostboxSweepMark, originId: string, id: string) => boolean;
	/** The list's scope (folder, filter); a change mid-sweep cancels it. */
	scopeKey: () => unknown;
	onCommit: (commit: PostboxSweepCommit) => void;
}

interface SweepState {
	mark: PostboxSweepMark;
	originId: string;
	pointerId: number;
	startX: number;
	startY: number;
	lastY: number;
	phase: 'pressed' | 'sweeping' | 'cancelled';
	targetId: string | null;
}

export function usePostboxSweep(options: PostboxSweepOptions) {
	let state: SweepState | null = null;
	/** The covered rows while sweeping; empty at rest and after a cancel. */
	const swept = shallowRef<ReadonlySet<string>>(new Set());
	const mark = ref<PostboxSweepMark | null>(null);
	let releaseClickSwallow: (() => void) | null = null;

	const canApply = (id: string) =>
		state !== null && (options.canApply?.(state.mark, state.originId, id) ?? true);

	function resolve(): string[] {
		if (!state || state.targetId === null) return [];
		return postboxSweepRange(options.orderedIds(), state.originId, state.targetId, canApply);
	}

	function rowAtY(y: number): string | null {
		const list = options.listEl();
		if (!list) return null;
		const rows: { id: string; top: number }[] = [];
		for (const el of list.querySelectorAll<HTMLElement>('[data-sweep-row]')) {
			const id = el.dataset['sweepRow'];
			if (id) rows.push({ id, top: el.getBoundingClientRect().top });
		}
		return postboxSweepRowAtY(rows, y);
	}

	function retarget(y: number) {
		if (!state || state.phase !== 'sweeping') return;
		state.lastY = y;
		const target = rowAtY(y);
		if (target !== null) state.targetId = target;
		swept.value = new Set(resolve());
	}

	function onPointermove(event: PointerEvent) {
		if (!state || event.pointerId !== state.pointerId || state.phase === 'cancelled') return;
		if (state.phase === 'pressed') {
			const dx = event.clientX - state.startX;
			const dy = event.clientY - state.startY;
			if (Math.hypot(dx, dy) < POSTBOX_SWEEP_START_PX) return;
			state.phase = 'sweeping';
			state.targetId = state.originId;
			mark.value = state.mark;
			// The press may already have begun a text selection across the rows.
			window.getSelection?.()?.removeAllRanges();
		}
		event.preventDefault();
		retarget(event.clientY);
	}

	function onScroll() {
		// The wheel moves rows under a still pointer: re-aim at the same height.
		if (state?.phase === 'sweeping') retarget(state.lastY);
	}

	/**
	 * The range as it resolves now, if it is still exactly the rows the preview
	 * showed; null once a live update has changed it (a row inserted between the
	 * ends, one reordered into or out of the interval, a covered row removed).
	 */
	function previewedRange(): string[] | null {
		const ids = resolve();
		const shown = swept.value;
		return ids.length === shown.size && ids.every((id) => shown.has(id)) ? ids : null;
	}

	function onPointerup(event: PointerEvent) {
		if (!state || event.pointerId !== state.pointerId) return;
		const finished = state;
		// Release applies what the pill and the marks promised, never a range the
		// person did not see: a list that changed under a still pointer applies nothing.
		const ids = finished.phase === 'sweeping' ? (previewedRange() ?? []) : [];
		// Released before moving: an ordinary click, left alone.
		if (finished.phase !== 'pressed') swallowNextClick();
		detach();
		if (finished.phase === 'sweeping' && ids.length > 0) {
			options.onCommit({ mark: finished.mark, originId: finished.originId, ids });
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !state || state.phase === 'cancelled') return;
		// Esc belongs to the sweep: it must not also close the open conversation.
		event.preventDefault();
		event.stopImmediatePropagation();
		cancel();
	}

	/**
	 * Abandon the sweep without applying anything. The button is still down, so
	 * the listeners stay until it comes up, to swallow the click that follows.
	 */
	function cancel() {
		if (!state || state.phase === 'cancelled') return;
		state.phase = 'cancelled';
		clearPreview();
	}

	function swallowNextClick() {
		releaseClickSwallow?.();
		const swallow = (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			release();
		};
		// The click is dispatched in the same task as the pointerup that ends the
		// sweep; if the browser sends none (pointer released over another
		// window), the listener must not wait around for the next real click.
		const timer = setTimeout(() => release(), 0);
		function release() {
			window.removeEventListener('click', swallow, true);
			clearTimeout(timer);
			if (releaseClickSwallow === release) releaseClickSwallow = null;
		}
		window.addEventListener('click', swallow, true);
		releaseClickSwallow = release;
	}

	function clearPreview() {
		if (swept.value.size > 0) swept.value = new Set();
		mark.value = null;
	}

	function onAbort() {
		detach();
	}

	function attach() {
		window.addEventListener('pointermove', onPointermove, true);
		window.addEventListener('pointerup', onPointerup, true);
		window.addEventListener('pointercancel', onAbort, true);
		window.addEventListener('blur', onAbort);
		// oxlint-disable-next-line owlat/no-raw-keydown-listener -- Escape cancels the sweep while the mouse button is held
		window.addEventListener('keydown', onKeydown, true);
		window.addEventListener('scroll', onScroll, true);
	}

	function detach() {
		window.removeEventListener('pointermove', onPointermove, true);
		window.removeEventListener('pointerup', onPointerup, true);
		window.removeEventListener('pointercancel', onAbort, true);
		window.removeEventListener('blur', onAbort);
		window.removeEventListener('keydown', onKeydown, true);
		window.removeEventListener('scroll', onScroll, true);
		state = null;
		clearPreview();
	}

	/**
	 * A press on a sweep handle. Returns whether it may become a sweep; a press
	 * that may not (touch, Shift, a secondary button) is left entirely alone.
	 */
	function start(kind: PostboxSweepKind, originId: string, event: PointerEvent): boolean {
		if (!isPostboxSweepPress(event)) return false;
		if (state) detach();
		state = {
			mark: postboxSweepMark(kind, options.isSelected(originId)),
			originId,
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			lastY: event.clientY,
			phase: 'pressed',
			targetId: null,
		};
		attach();
		return true;
	}

	/** The pending result for one row, or null when no sweep covers it. */
	function markOf(id: string): PostboxSweepMark | null {
		return mark.value !== null && swept.value.has(id) ? mark.value : null;
	}

	/** What the count pill says while a sweep is in flight. */
	const status = computed(() =>
		mark.value === null || swept.value.size === 0
			? null
			: { mark: mark.value, count: swept.value.size }
	);

	watch(options.scopeKey, () => cancel());

	// A live update can move rows under a pointer that is not moving. Re-aiming
	// silently could slip unseen rows into the range just before release, so a
	// sweep whose covered rows changed is cancelled instead (the pill goes away).
	watch(options.orderedIds, () => {
		if (state?.phase === 'sweeping' && previewedRange() === null) cancel();
	});

	onScopeDispose(() => {
		detach();
		releaseClickSwallow?.();
	});

	return { start, cancel, markOf, status, active: computed(() => mark.value !== null) };
}
