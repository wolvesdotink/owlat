/**
 * The geometry under `useVirtualList`: prefix sums, the binary search from a
 * scroll position to a row, the mounted range, and the anchor arithmetic that
 * keeps the reader's row in place when the rows above it change.
 */
import { describe, expect, it } from 'vitest';
import {
	buildVirtualListLayout,
	captureVirtualListAnchors,
	restoreVirtualListAnchor,
	virtualListHeight,
	virtualRowAt,
	virtualRowRange,
	virtualRowSize,
} from '../virtualListLayout';

const keys = (count: number) => Array.from({ length: count }, (_, i) => `r${i}`);

describe('virtualListLayout', () => {
	it('lays rows out as prefix sums of their sizes', () => {
		const layout = buildVirtualListLayout(['a', 'b', 'c'], (i) => [10, 20, 30][i]!);
		expect([...layout.starts]).toEqual([0, 10, 30, 60]);
		expect(virtualListHeight(layout)).toBe(60);
		expect(virtualRowSize(layout, 1)).toBe(20);
		expect(layout.indexOf.get('c')).toBe(2);
	});

	it('treats a negative size as zero', () => {
		const layout = buildVirtualListLayout(['a', 'b'], (i) => (i === 0 ? -5 : 10));
		expect([...layout.starts]).toEqual([0, 0, 10]);
	});

	it('finds the row covering a position, clamped to the list', () => {
		const layout = buildVirtualListLayout(keys(4), () => 10);
		expect(virtualRowAt(layout, -50)).toBe(0);
		expect(virtualRowAt(layout, 0)).toBe(0);
		expect(virtualRowAt(layout, 9.9)).toBe(0);
		expect(virtualRowAt(layout, 10)).toBe(1);
		expect(virtualRowAt(layout, 35)).toBe(3);
		expect(virtualRowAt(layout, 1000)).toBe(3);
		const empty = buildVirtualListLayout([], () => 10);
		expect(virtualRowAt(empty, 0)).toBe(-1);
	});

	it('mounts the viewport plus the overscan on both sides', () => {
		const layout = buildVirtualListLayout(keys(500), () => 50);
		// Viewport [10000, 10400), 100px overscan: rows 198 (9900) to 210 (10500).
		expect(virtualRowRange(layout, 10_000, 400, 100)).toEqual({ start: 198, end: 211 });
		expect(virtualRowRange(layout, 0, 400, 100)).toEqual({ start: 0, end: 11 });
		expect(virtualRowRange(layout, 24_600, 400, 100)).toEqual({ start: 490, end: 500 });
		const empty = buildVirtualListLayout([], () => 50);
		expect(virtualRowRange(empty, 0, 400, 100)).toEqual({ start: 0, end: 0 });
	});

	it('anchors to the visible rows with their offset from the viewport top', () => {
		const layout = buildVirtualListLayout(keys(10), () => 100);
		const anchors = captureVirtualListAnchors(layout, 150, 250);
		expect(anchors).toEqual([
			{ key: 'r1', offset: -50 },
			{ key: 'r2', offset: 50 },
			{ key: 'r3', offset: 150 },
		]);
	});

	it('restores the first surviving anchor after rows above it changed', () => {
		const before = buildVirtualListLayout(keys(10), () => 100);
		const anchors = captureVirtualListAnchors(before, 450, 200);
		// Two rows inserted above, the anchor row itself deleted.
		const afterKeys = ['x', 'y', ...keys(10).filter((k) => k !== 'r4')];
		const after = buildVirtualListLayout(afterKeys, () => 100);
		// r5 sat 50px below the top; it now starts at 600 (x, y, r0..r3).
		expect(restoreVirtualListAnchor(after, anchors)).toBe(550);
		expect(restoreVirtualListAnchor(after, [{ key: 'gone', offset: 0 }])).toBeNull();
	});
});
