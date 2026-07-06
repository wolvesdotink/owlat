/**
 * Chart kit — pure geometry/format helpers shared by UiTrendChart,
 * UiSparkline and UiBars. No DOM, no Vue: everything here is unit-testable.
 */

export interface ChartDatum {
	label: string;
	value: number;
}

export interface ChartPoint {
	x: number;
	y: number;
	label: string;
	value: number;
}

export interface ChartFrame {
	width: number;
	height: number;
	padding: { top: number; right: number; bottom: number; left: number };
}

/** Compact numeric formatting for axis labels and tooltips (1.2k, 0.25, 3). */
export function formatChartValue(v: number): string {
	if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
	if (v > 0 && v < 0.01) return v.toExponential(1);
	if (Number.isInteger(v)) return String(v);
	return v.toFixed(2);
}

/**
 * Y-domain with 10% headroom on each side, clamped at zero — counts and
 * rates never dip below the baseline just because of padding.
 */
export function computeYBounds(values: number[], padRatio = 0.1): { min: number; max: number } {
	if (values.length === 0) return { min: 0, max: 1 };
	const min = Math.min(...values);
	const max = Math.max(...values);
	const pad = (max - min) * padRatio || 1;
	return { min: Math.max(0, min - pad), max: max + pad };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Map categorical data (evenly spaced on x) into pixel points inside the
 * frame's inner plot area. A single datum centers horizontally.
 */
export function computeChartPoints(data: ChartDatum[], frame: ChartFrame): ChartPoint[] {
	if (data.length === 0) return [];
	const { width, height, padding } = frame;
	const innerWidth = width - padding.left - padding.right;
	const innerHeight = height - padding.top - padding.bottom;
	const { min, max } = computeYBounds(data.map((d) => d.value));
	const yRange = max - min || 1;
	const lastIndex = data.length - 1;

	return data.map((d, i) => ({
		x: round2(padding.left + (lastIndex === 0 ? innerWidth / 2 : (i / lastIndex) * innerWidth)),
		y: round2(padding.top + innerHeight - ((d.value - min) / yRange) * innerHeight),
		label: d.label,
		value: d.value,
	}));
}

/** SVG polyline `points` attribute for a set of chart points. */
export function buildLinePoints(points: ChartPoint[]): string {
	return points.map((p) => `${p.x},${p.y}`).join(' ');
}

/** Closed SVG path for the area under the line, anchored to the baseline. */
export function buildAreaPath(points: ChartPoint[], baselineY: number): string {
	if (points.length < 2) return '';
	const first = points[0]!;
	const last = points[points.length - 1]!;
	let path = `M ${first.x},${baselineY} L ${first.x},${first.y}`;
	for (let i = 1; i < points.length; i++) {
		path += ` L ${points[i]!.x},${points[i]!.y}`;
	}
	path += ` L ${last.x},${baselineY} Z`;
	return path;
}

/** Index of the point whose x is nearest to the pointer's x (crosshair hover). */
export function nearestPointIndex(points: ChartPoint[], x: number): number {
	if (points.length === 0) return -1;
	let best = 0;
	let bestDistance = Math.abs(points[0]!.x - x);
	for (let i = 1; i < points.length; i++) {
		const distance = Math.abs(points[i]!.x - x);
		if (distance < bestDistance) {
			best = i;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * Bar height as a percentage of the plot height. Non-zero values get a
 * minimum visible height; zeros are handled by the component (baseline stub).
 */
export function computeBarHeightPercent(value: number, maxValue: number, minPercent = 4): number {
	if (value <= 0 || maxValue <= 0) return 0;
	return Math.max((value / maxValue) * 100, minPercent);
}
