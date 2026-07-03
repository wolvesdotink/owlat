/**
 * Range mapping + focus-follow math for the windowed thread list
 * (usePostboxVirtualList). Pure functions, no DOM: given a scroll position and
 * a fixed row height they must yield the correct render window (with overscan
 * clamped at both ends) and the scrollTop that reveals an off-window row.
 */
import { describe, it, expect } from 'vitest';
import {
	computeVirtualRange,
	scrollTopToRevealIndex,
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
		expect(computeVirtualRange({ scrollTop: 0, viewportHeight: VIEWPORT, rowHeight: ROW, itemCount: 0, overscan: 10 }))
			.toEqual({ startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: 0 });
		expect(computeVirtualRange({ scrollTop: 0, viewportHeight: VIEWPORT, rowHeight: 0, itemCount: 10, overscan: 10 }))
			.toEqual({ startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: 0 });
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
