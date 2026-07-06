import { describe, expect, it } from 'vitest';
import {
	buildAreaPath,
	buildLinePoints,
	computeBarHeightPercent,
	computeChartPoints,
	computeYBounds,
	formatChartValue,
	nearestPointIndex,
	type ChartDatum,
	type ChartFrame,
} from '../chart';

const frame: ChartFrame = {
	width: 320,
	height: 120,
	padding: { top: 16, right: 12, bottom: 24, left: 48 },
};

const data: ChartDatum[] = [
	{ label: 'Mon', value: 0 },
	{ label: 'Tue', value: 50 },
	{ label: 'Wed', value: 100 },
];

describe('formatChartValue', () => {
	it('abbreviates thousands with one decimal', () => {
		expect(formatChartValue(1000)).toBe('1.0k');
		expect(formatChartValue(12345)).toBe('12.3k');
		expect(formatChartValue(-2500)).toBe('-2.5k');
	});

	it('keeps integers plain', () => {
		expect(formatChartValue(0)).toBe('0');
		expect(formatChartValue(42)).toBe('42');
	});

	it('shows two decimals for small fractions', () => {
		expect(formatChartValue(0.256)).toBe('0.26');
	});

	it('uses exponential notation for tiny positive values', () => {
		expect(formatChartValue(0.001)).toBe('1.0e-3');
	});
});

describe('computeYBounds', () => {
	it('returns a unit domain for empty input', () => {
		expect(computeYBounds([])).toEqual({ min: 0, max: 1 });
	});

	it('pads 10% on each side', () => {
		expect(computeYBounds([10, 110])).toEqual({ min: 0, max: 120 });
	});

	it('never dips below zero', () => {
		const { min } = computeYBounds([2, 100]);
		expect(min).toBe(0);
	});

	it('pads flat series by 1 so the line is not glued to an edge', () => {
		expect(computeYBounds([5, 5, 5])).toEqual({ min: 4, max: 6 });
	});
});

describe('computeChartPoints', () => {
	it('returns no points for empty data', () => {
		expect(computeChartPoints([], frame)).toEqual([]);
	});

	it('spaces points evenly across the inner width', () => {
		const points = computeChartPoints(data, frame);
		expect(points).toHaveLength(3);
		expect(points[0]!.x).toBe(48); // padding.left
		expect(points[1]!.x).toBe(48 + 130); // midpoint of innerWidth 260
		expect(points[2]!.x).toBe(48 + 260); // right edge of the plot
	});

	it('maps larger values to smaller y (SVG grows downward)', () => {
		const points = computeChartPoints(data, frame);
		expect(points[2]!.y).toBeLessThan(points[1]!.y);
		expect(points[1]!.y).toBeLessThan(points[0]!.y);
	});

	it('keeps y inside the plot area', () => {
		const points = computeChartPoints(data, frame);
		for (const p of points) {
			expect(p.y).toBeGreaterThanOrEqual(frame.padding.top);
			expect(p.y).toBeLessThanOrEqual(frame.height - frame.padding.bottom);
		}
	});

	it('centers a single datum horizontally', () => {
		const points = computeChartPoints([{ label: 'Mon', value: 5 }], frame);
		expect(points[0]!.x).toBe(48 + 130);
	});

	it('carries label and value through', () => {
		const points = computeChartPoints(data, frame);
		expect(points[1]).toMatchObject({ label: 'Tue', value: 50 });
	});
});

describe('buildLinePoints', () => {
	it('serializes points for the SVG polyline attribute', () => {
		const points = computeChartPoints(data, frame);
		expect(buildLinePoints(points)).toBe(points.map((p) => `${p.x},${p.y}`).join(' '));
	});
});

describe('buildAreaPath', () => {
	it('returns an empty path for fewer than two points', () => {
		expect(buildAreaPath([], 96)).toBe('');
		expect(buildAreaPath(computeChartPoints([{ label: 'a', value: 1 }], frame), 96)).toBe('');
	});

	it('anchors the area to the baseline and closes the path', () => {
		const points = computeChartPoints(data, frame);
		const path = buildAreaPath(points, 96);
		expect(path.startsWith(`M ${points[0]!.x},96 L ${points[0]!.x},${points[0]!.y}`)).toBe(true);
		expect(path.endsWith(`L ${points[2]!.x},96 Z`)).toBe(true);
	});
});

describe('nearestPointIndex', () => {
	const points = computeChartPoints(data, frame);

	it('returns -1 for no points', () => {
		expect(nearestPointIndex([], 100)).toBe(-1);
	});

	it('finds the closest point on each side', () => {
		expect(nearestPointIndex(points, 0)).toBe(0);
		expect(nearestPointIndex(points, 180)).toBe(1);
		expect(nearestPointIndex(points, 9999)).toBe(2);
	});
});

describe('computeBarHeightPercent', () => {
	it('is zero for zero or negative values', () => {
		expect(computeBarHeightPercent(0, 100)).toBe(0);
		expect(computeBarHeightPercent(-5, 100)).toBe(0);
	});

	it('is zero when the max is not positive', () => {
		expect(computeBarHeightPercent(5, 0)).toBe(0);
	});

	it('scales linearly against the max', () => {
		expect(computeBarHeightPercent(50, 100)).toBe(50);
		expect(computeBarHeightPercent(100, 100)).toBe(100);
	});

	it('enforces a minimum visible height for tiny non-zero values', () => {
		expect(computeBarHeightPercent(1, 1000)).toBe(4);
		expect(computeBarHeightPercent(1, 1000, 6)).toBe(6);
	});
});
