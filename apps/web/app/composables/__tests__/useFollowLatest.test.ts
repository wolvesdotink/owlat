// @vitest-environment happy-dom
/**
 * The Assistant feed follows a streaming answer only while the reader is at
 * the end (#1050). Scrolling up to reread is respected across text and
 * tool/status updates; new content below raises the jump pill instead; the
 * pill (and the member's own send) go back to the end and follow again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { FOLLOW_LATEST_THRESHOLD_PX, useFollowLatest } from '../useFollowLatest';

/** A scroll container with settable geometry; happy-dom does no layout. */
function fakeFeed(initial: { scrollHeight: number; clientHeight: number }) {
	const el = document.createElement('div');
	const box = { ...initial, scrollTop: 0 };
	Object.defineProperty(el, 'scrollHeight', { get: () => box.scrollHeight });
	Object.defineProperty(el, 'clientHeight', { get: () => box.clientHeight });
	Object.defineProperty(el, 'scrollTop', {
		get: () => box.scrollTop,
		set: (v: number) => (box.scrollTop = Math.min(v, box.scrollHeight - box.clientHeight)),
	});
	const scrollTo = vi.fn((opts: ScrollToOptions) => {
		el.scrollTop = opts.top ?? 0;
	});
	(el as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;
	return { el, box, scrollTo };
}

let reducedMotion = false;
beforeEach(() => {
	reducedMotion = false;
	window.matchMedia = vi.fn((query: string) => ({
		matches: query.includes('reduce') ? reducedMotion : false,
	})) as unknown as typeof window.matchMedia;
});

function setup() {
	const feed = fakeFeed({ scrollHeight: 2000, clientHeight: 500 });
	const scrollRef = ref<HTMLElement | null>(feed.el);
	const follow = useFollowLatest(scrollRef);
	const scrollUserTo = (top: number) => {
		feed.el.scrollTop = top;
		follow.onScroll();
	};
	const grow = async (by: number) => {
		feed.box.scrollHeight += by;
		follow.onContent();
		await nextTick();
	};
	return { ...feed, ...follow, scrollUserTo, grow };
}

describe('useFollowLatest (#1050)', () => {
	it('follows new content while the reader is at the end', async () => {
		const f = setup();
		f.scrollUserTo(1500);
		await f.grow(120);

		expect(f.el.scrollTop).toBe(1620);
		expect(f.hasNewBelow.value).toBe(false);
	});

	it('keeps following within the threshold of the end', async () => {
		const f = setup();
		f.scrollUserTo(1500);
		f.scrollUserTo(1500 - FOLLOW_LATEST_THRESHOLD_PX);
		await f.grow(40);

		expect(f.following.value).toBe(true);
		expect(f.el.scrollTop).toBe(1540);
	});

	it('leaves a reader who scrolled up where they are, across every update', async () => {
		const f = setup();
		f.scrollUserTo(1500);
		f.scrollUserTo(600);
		await f.grow(80); // streamed text
		await f.grow(0); // a tool call or status flips, nothing taller

		expect(f.el.scrollTop).toBe(600);
		expect(f.following.value).toBe(false);
		expect(f.hasNewBelow.value).toBe(true);
	});

	it('shows the pill only once new content exists below', () => {
		const f = setup();
		f.scrollUserTo(1500);
		f.scrollUserTo(600);

		expect(f.following.value).toBe(false);
		expect(f.hasNewBelow.value).toBe(false);
	});

	it('jump to latest scrolls down, clears the pill and follows again', async () => {
		const f = setup();
		f.scrollUserTo(1500);
		f.scrollUserTo(600);
		await f.grow(100);

		await f.jumpToLatest();
		expect(f.scrollTo).toHaveBeenLastCalledWith({ top: 2100, behavior: 'smooth' });
		expect(f.hasNewBelow.value).toBe(false);
		await f.grow(50);
		expect(f.el.scrollTop).toBe(1650);
	});

	it('scrolling back to the end by hand resumes following', async () => {
		const f = setup();
		f.scrollUserTo(1500);
		f.scrollUserTo(600);
		await f.grow(100);
		f.scrollUserTo(1580);

		expect(f.following.value).toBe(true);
		expect(f.hasNewBelow.value).toBe(false);
	});

	it('does not stop following when the end moves away without the reader scrolling', async () => {
		const f = setup();
		f.scrollUserTo(1500);
		// A smooth scroll on its way down reports positions short of the end.
		f.box.scrollHeight = 4000;
		f.scrollUserTo(1800);
		await f.grow(10);

		expect(f.following.value).toBe(true);
		expect(f.el.scrollTop).toBe(3510);
	});

	it('jumps without animation under prefers-reduced-motion', async () => {
		reducedMotion = true;
		const f = setup();
		await f.jumpToLatest();
		expect(f.scrollTo).toHaveBeenLastCalledWith({ top: 2000, behavior: 'auto' });
	});
});
