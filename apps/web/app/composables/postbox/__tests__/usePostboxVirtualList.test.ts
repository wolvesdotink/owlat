/**
 * Range mapping + focus-follow math for the windowed thread list
 * (usePostboxVirtualList). Pure functions, no DOM: given a scroll position and
 * a fixed row height they must yield the correct render window (with overscan
 * clamped at both ends) and the scrollTop that reveals an off-window row.
 */
import { describe, it, expect, vi } from 'vitest';
import {
	computeVirtualRange,
	computeSectionedVirtualRanges,
	createRafThrottle,
	isNearListEnd,
	scrollTopToRevealIndex,
	scrollTopToRevealSectionedIndex,
	sectionedRowTop,
} from '../usePostboxVirtualList';

const ROW = 76;
const VIEWPORT = 760; // exactly 10 rows tall

describe('computeVirtualRange', () => {
	it('reports the full scroll height regardless of the window', () => {
		const r = computeVirtualRange({
			scrollTop: 0,
			viewportHeight: VIEWPORT,
			rowHeight: ROW,
			itemCount: 1000,
			overscan: 10,
		});
		expect(r.totalHeight).toBe(1000 * ROW);
	});

	it('clamps the overscan at the top (no negative indices, offset 0)', () => {
		const r = computeVirtualRange({
			scrollTop: 0,
			viewportHeight: VIEWPORT,
			rowHeight: ROW,
			itemCount: 1000,
			overscan: 10,
		});
		expect(r.startIndex).toBe(0);
		expect(r.offsetY).toBe(0);
		// 10 visible + 10 overscan + 1 partial guard.
		expect(r.endIndex).toBe(21);
	});

	it('windows to the visible slice in the middle with symmetric overscan', () => {
		const r = computeVirtualRange({
			scrollTop: 100 * ROW,
			viewportHeight: VIEWPORT,
			rowHeight: ROW,
			itemCount: 1000,
			overscan: 10,
		});
		expect(r.startIndex).toBe(90); // 100 - 10 overscan
		expect(r.offsetY).toBe(90 * ROW); // inner container translate
		expect(r.endIndex).toBe(121); // 100 + 10 visible + 10 overscan + 1
		// Rendered row count stays bounded (viewport + 2*overscan + 1).
		expect(r.endIndex - r.startIndex).toBe(31);
	});

	it('clamps the overscan at the bottom (endIndex never exceeds itemCount)', () => {
		const r = computeVirtualRange({
			scrollTop: 995 * ROW,
			viewportHeight: VIEWPORT,
			rowHeight: ROW,
			itemCount: 1000,
			overscan: 10,
		});
		expect(r.endIndex).toBe(1000);
		expect(r.startIndex).toBe(985);
	});

	it('handles an empty list and a zero row height without dividing by zero', () => {
		expect(
			computeVirtualRange({
				scrollTop: 0,
				viewportHeight: VIEWPORT,
				rowHeight: ROW,
				itemCount: 0,
				overscan: 10,
			})
		).toEqual({ startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: 0 });
		expect(
			computeVirtualRange({
				scrollTop: 0,
				viewportHeight: VIEWPORT,
				rowHeight: 0,
				itemCount: 10,
				overscan: 10,
			})
		).toEqual({ startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: 0 });
	});
});

describe('scrollTopToRevealIndex (focus-follow)', () => {
	it('scrolls up to the row top when the focused row is above the window', () => {
		// Window shows rows 90..99; focus jumps to row 40 (far above).
		const next = scrollTopToRevealIndex({
			index: 40,
			rowHeight: ROW,
			scrollTop: 90 * ROW,
			viewportHeight: VIEWPORT,
		});
		expect(next).toBe(40 * ROW);
	});

	it('scrolls down so the row bottom aligns when it is below the window', () => {
		// Viewport shows rows 0..9; focus jumps to row 20 (below).
		const next = scrollTopToRevealIndex({
			index: 20,
			rowHeight: ROW,
			scrollTop: 0,
			viewportHeight: VIEWPORT,
		});
		// rowBottom (21*ROW) - viewport => row 20 sits at the bottom edge.
		expect(next).toBe(21 * ROW - VIEWPORT);
	});

	it('leaves the scroll untouched when the row is already visible', () => {
		const next = scrollTopToRevealIndex({
			index: 5,
			rowHeight: ROW,
			scrollTop: 0,
			viewportHeight: VIEWPORT,
		});
		expect(next).toBe(0);
	});
});

// --- Section-aware windowing (grouped renderers) ------------------------------

const HEADER = 32;

describe('computeSectionedVirtualRanges', () => {
	it('adds each section header to the total height', () => {
		const r = computeSectionedVirtualRanges({
			scrollTop: 0,
			viewportHeight: VIEWPORT,
			rowHeight: ROW,
			headerHeight: HEADER,
			sectionCounts: [10, 20, 5],
			overscan: 0,
		});
		expect(r.totalHeight).toBe(3 * HEADER + 35 * ROW);
	});

	it('mounts only the first section near the top and nothing below it', () => {
		const r = computeSectionedVirtualRanges({
			scrollTop: 0,
			viewportHeight: VIEWPORT,
			rowHeight: ROW,
			headerHeight: HEADER,
			sectionCounts: [100, 100],
			overscan: 0,
		});
		// 760px of viewport minus the 32px header leaves the first 10 rows.
		expect(r.sections[0]).toEqual({
			startIndex: 0,
			endIndex: 10,
			padTop: 0,
			padBottom: 90 * ROW,
		});
		// The second section starts below the fold: an empty window, all spacer.
		expect(r.sections[1]).toEqual({
			startIndex: 0,
			endIndex: 0,
			padTop: 0,
			padBottom: 100 * ROW,
		});
	});

	it('offsets the second section by the first section AND both headers', () => {
		// Park the viewport exactly at the second section's first row.
		const secondSectionTop = HEADER + 100 * ROW + HEADER;
		const r = computeSectionedVirtualRanges({
			scrollTop: secondSectionTop,
			viewportHeight: VIEWPORT,
			rowHeight: ROW,
			headerHeight: HEADER,
			sectionCounts: [100, 100],
			overscan: 0,
		});
		expect(r.sections[0]).toEqual({
			startIndex: 100,
			endIndex: 100,
			padTop: 100 * ROW,
			padBottom: 0,
		});
		expect(r.sections[1]?.startIndex).toBe(0);
		expect(r.sections[1]?.endIndex).toBe(10);
	});

	it('spends no rows on a collapsed section but still charges its header', () => {
		const r = computeSectionedVirtualRanges({
			scrollTop: 0,
			viewportHeight: VIEWPORT,
			rowHeight: ROW,
			headerHeight: HEADER,
			sectionCounts: [0, 100],
			overscan: 0,
		});
		expect(r.sections[0]).toEqual({ startIndex: 0, endIndex: 0, padTop: 0, padBottom: 0 });
		// The collapsed section's header pushed the open one down by 2 headers.
		expect(r.sections[1]?.endIndex).toBe(Math.ceil((VIEWPORT - 2 * HEADER) / ROW));
	});

	it('clamps overscan inside each section (never a negative or past-the-end index)', () => {
		const r = computeSectionedVirtualRanges({
			scrollTop: HEADER + 50 * ROW,
			viewportHeight: VIEWPORT,
			rowHeight: ROW,
			headerHeight: HEADER,
			sectionCounts: [55],
			overscan: 10,
		});
		expect(r.sections[0]?.startIndex).toBe(40);
		expect(r.sections[0]?.endIndex).toBe(55);
		expect(r.sections[0]?.padBottom).toBe(0);
	});

	it('renders nothing for a zero row height instead of dividing by zero', () => {
		const r = computeSectionedVirtualRanges({
			scrollTop: 0,
			viewportHeight: VIEWPORT,
			rowHeight: 0,
			headerHeight: HEADER,
			sectionCounts: [10, 10],
			overscan: 10,
		});
		expect(r.totalHeight).toBe(2 * HEADER);
		expect(r.sections).toEqual([
			{ startIndex: 0, endIndex: 0, padTop: 0, padBottom: 0 },
			{ startIndex: 0, endIndex: 0, padTop: 0, padBottom: 0 },
		]);
	});
});

describe('sectionedRowTop / scrollTopToRevealSectionedIndex', () => {
	it('locates a flat index across sections, counting the headers it passed', () => {
		const sectionCounts = [3, 4];
		expect(
			sectionedRowTop({ flatIndex: 0, rowHeight: ROW, headerHeight: HEADER, sectionCounts })
		).toBe(HEADER);
		expect(
			sectionedRowTop({ flatIndex: 2, rowHeight: ROW, headerHeight: HEADER, sectionCounts })
		).toBe(HEADER + 2 * ROW);
		// First row of the second section: both headers + the first section's rows.
		expect(
			sectionedRowTop({ flatIndex: 3, rowHeight: ROW, headerHeight: HEADER, sectionCounts })
		).toBe(2 * HEADER + 3 * ROW);
	});

	it('returns null for an index past the last row', () => {
		expect(
			sectionedRowTop({ flatIndex: 7, rowHeight: ROW, headerHeight: HEADER, sectionCounts: [3, 4] })
		).toBeNull();
		expect(
			sectionedRowTop({ flatIndex: -1, rowHeight: ROW, headerHeight: HEADER, sectionCounts: [3] })
		).toBeNull();
	});

	it('scrolls a below-the-fold row up to the viewport bottom, and leaves a visible one alone', () => {
		const sectionCounts = [100, 100];
		const below = scrollTopToRevealSectionedIndex({
			flatIndex: 30,
			rowHeight: ROW,
			headerHeight: HEADER,
			sectionCounts,
			scrollTop: 0,
			viewportHeight: VIEWPORT,
		});
		expect(below).toBe(HEADER + 31 * ROW - VIEWPORT);

		const visible = scrollTopToRevealSectionedIndex({
			flatIndex: 2,
			rowHeight: ROW,
			headerHeight: HEADER,
			sectionCounts,
			scrollTop: 0,
			viewportHeight: VIEWPORT,
		});
		expect(visible).toBe(0);
	});

	it('leaves the scroll untouched for an out-of-range index', () => {
		expect(
			scrollTopToRevealSectionedIndex({
				flatIndex: 99,
				rowHeight: ROW,
				headerHeight: HEADER,
				sectionCounts: [3],
				scrollTop: 120,
				viewportHeight: VIEWPORT,
			})
		).toBe(120);
	});
});

describe('isNearListEnd', () => {
	it('fires inside the margin and stays quiet outside it', () => {
		expect(
			isNearListEnd({ scrollTop: 900, scrollHeight: 2000, clientHeight: 1000, marginPx: 240 })
		).toBe(true);
		expect(
			isNearListEnd({ scrollTop: 500, scrollHeight: 2000, clientHeight: 1000, marginPx: 240 })
		).toBe(false);
	});

	it('is true for content shorter than the viewport (there is no scroll to do)', () => {
		expect(
			isNearListEnd({ scrollTop: 0, scrollHeight: 300, clientHeight: 1000, marginPx: 240 })
		).toBe(true);
	});
});

describe('createRafThrottle', () => {
	it('runs the callback once per frame however many times it is scheduled', async () => {
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
			frames.push(cb);
			return frames.length;
		});
		vi.stubGlobal('cancelAnimationFrame', () => {});
		const fn = vi.fn();
		const throttle = createRafThrottle(fn);

		throttle.schedule();
		throttle.schedule();
		throttle.schedule();
		expect(fn).not.toHaveBeenCalled();
		expect(frames).toHaveLength(1);

		frames[0]?.(0);
		expect(fn).toHaveBeenCalledTimes(1);

		// The frame released the slot, so a later burst schedules again.
		throttle.schedule();
		expect(frames).toHaveLength(2);
		vi.unstubAllGlobals();
	});

	it('calls straight through where requestAnimationFrame does not exist', () => {
		vi.stubGlobal('requestAnimationFrame', undefined);
		const fn = vi.fn();
		createRafThrottle(fn).schedule();
		expect(fn).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});
});
