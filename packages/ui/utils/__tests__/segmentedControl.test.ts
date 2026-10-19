import { describe, expect, it } from 'vitest';
import { segmentEnabledIndex, segmentTabStopIndex, type SegmentLike } from '../segmentedControl';

/** A, disabled B, C: the shape that used to strand ArrowRight on A. */
const ABC: SegmentLike[] = [{ value: 'a' }, { value: 'b', disabled: true }, { value: 'c' }];

/** Disabled endpoints: Home/End used to stop on them and do nothing. */
const EDGES: SegmentLike[] = [
	{ value: 'a', disabled: true },
	{ value: 'b' },
	{ value: 'c' },
	{ value: 'd', disabled: true },
];

const ALL_DISABLED: SegmentLike[] = [
	{ value: 'a', disabled: true },
	{ value: 'b', disabled: true },
];

describe('segmentEnabledIndex', () => {
	it('steps over a disabled neighbour in either direction', () => {
		expect(segmentEnabledIndex(ABC, 1, 1)).toBe(2);
		expect(segmentEnabledIndex(ABC, 1, -1)).toBe(0);
	});

	it('wraps past the ends, skipping disabled options on the way', () => {
		// ArrowRight from C wraps to A; ArrowLeft from A wraps to C.
		expect(segmentEnabledIndex(ABC, 3, 1)).toBe(0);
		expect(segmentEnabledIndex(ABC, -1, -1)).toBe(2);
		// ArrowRight from C wraps over disabled D and A to B.
		expect(segmentEnabledIndex(EDGES, 3, 1)).toBe(1);
		// ArrowLeft from B wraps over disabled A and D to C.
		expect(segmentEnabledIndex(EDGES, 0, -1)).toBe(2);
	});

	it('resolves Home/End to the first and last enabled options', () => {
		expect(segmentEnabledIndex(EDGES, 0, 1)).toBe(1);
		expect(segmentEnabledIndex(EDGES, EDGES.length - 1, -1)).toBe(2);
	});

	it('comes back to the start when it is the only enabled option', () => {
		const lone: SegmentLike[] = [{ value: 'a' }, { value: 'b', disabled: true }];
		expect(segmentEnabledIndex(lone, 1, 1)).toBe(0);
		expect(segmentEnabledIndex(lone, -1, -1)).toBe(0);
	});

	it('returns -1 for all-disabled and empty lists', () => {
		for (const step of [1, -1] as const) {
			expect(segmentEnabledIndex(ALL_DISABLED, 0, step)).toBe(-1);
			expect(segmentEnabledIndex([], 0, step)).toBe(-1);
		}
	});
});

describe('segmentTabStopIndex', () => {
	it('is the selected option when it is enabled', () => {
		expect(segmentTabStopIndex(ABC, 'c')).toBe(2);
	});

	it('falls back to the first enabled option without a usable selection', () => {
		expect(segmentTabStopIndex(EDGES, undefined)).toBe(1);
		expect(segmentTabStopIndex(EDGES, 'gone')).toBe(1);
		expect(segmentTabStopIndex(EDGES, 'a')).toBe(1);
	});

	it('is -1 when nothing can take focus', () => {
		expect(segmentTabStopIndex(ALL_DISABLED, 'a')).toBe(-1);
		expect(segmentTabStopIndex([], undefined)).toBe(-1);
	});
});
