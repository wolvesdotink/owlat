/**
 * Keeps the message being answered in view when Answer mode opens on a phone
 * or tablet (a conversation above a sheet). Threads read oldest first, so the
 * catch-up card and the older rows can fill the first screen and push the
 * newest message, the one being answered, under the fold.
 *
 * The conversation marks that message `data-answer-anchor`. While the column
 * fills in (rows, the card, bodies arrive at different times), each change
 * checks whether the anchor's top is below the visible part and, if so,
 * scrolls it to the top. It stops for good the moment the person scrolls,
 * taps or types in the column themselves: from then on the view is theirs.
 */
import { onBeforeUnmount, onMounted, type Ref } from 'vue';

/** An anchor this close to the bottom still counts as below the fold. */
const FOLD_MARGIN_PX = 96;

export function useAnswerAnchor(opts: {
	/** The scrolling conversation column. */
	column: Readonly<Ref<HTMLElement | null>>;
	/** Anchor only in the stacked layouts; side by side has the room. */
	active: () => boolean;
}) {
	let observer: MutationObserver | null = null;
	let frame = 0;
	let done = false;

	function check() {
		frame = 0;
		const column = opts.column.value;
		if (done || !column || !opts.active()) return;
		const anchor = column.querySelector<HTMLElement>('[data-answer-anchor]');
		if (!anchor) return;
		const columnBox = column.getBoundingClientRect();
		if (anchor.getBoundingClientRect().top <= columnBox.bottom - FOLD_MARGIN_PX) return;
		anchor.scrollIntoView({ block: 'start', behavior: 'auto' });
	}

	function schedule() {
		if (frame || done) return;
		frame = requestAnimationFrame(check);
	}

	/** The person took over the column: leave the scroll position alone. */
	function stop() {
		done = true;
		observer?.disconnect();
		observer = null;
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
		const column = opts.column.value;
		for (const type of USER_EVENTS) column?.removeEventListener(type, stop);
	}

	onMounted(() => {
		const column = opts.column.value;
		if (!column || typeof MutationObserver === 'undefined') return;
		observer = new MutationObserver(schedule);
		observer.observe(column, { childList: true, subtree: true });
		for (const type of USER_EVENTS) column.addEventListener(type, stop, { passive: true });
		schedule();
	});
	onBeforeUnmount(stop);

	return { check };
}

// `click` too: screen readers on phones activate with a click and no pointer events.
const USER_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown', 'click'] as const;
