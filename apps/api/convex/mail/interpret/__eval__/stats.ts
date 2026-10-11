/**
 * Report math for the decision eval: proportions with confidence intervals,
 * Brier scores, reliability bins, agreement (Cohen's kappa), and the upper
 * bound that keeps "zero observed failures" from reading as "safe".
 *
 * Every function is pure and total: an empty input gives `null` estimates,
 * never NaN, so a report built from a partial run stays valid JSON.
 */

/** A proportion with its 95% Wilson score interval. */
export interface Interval {
	successes: number;
	n: number;
	/** `successes / n`, or null when `n` is 0. */
	estimate: number | null;
	low: number | null;
	high: number | null;
}

/** z for a two-sided 95% interval. */
const Z95 = 1.959963984540054;

/**
 * Wilson score interval for `successes` out of `n`. Preferred over the normal
 * approximation because it stays inside [0, 1] and is honest at 0 or n
 * successes, which is where a small eval corpus spends most of its time.
 */
export function wilson(successes: number, n: number, z: number = Z95): Interval {
	if (n === 0) return { successes, n, estimate: null, low: null, high: null };
	const p = successes / n;
	const z2 = z * z;
	const denominator = 1 + z2 / n;
	const centre = (p + z2 / (2 * n)) / denominator;
	const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
	return {
		successes,
		n,
		estimate: p,
		low: Math.max(0, centre - half),
		high: Math.min(1, centre + half),
	};
}

/**
 * One-sided 95% upper bound on a failure rate when no failure was observed in
 * `n` trials (exact binomial: `1 - 0.05^(1/n)`, about `3/n`). Zero observed
 * failures is not a safety guarantee; this is the rate the data cannot rule out.
 */
export function zeroFailureUpper95(n: number): number | null {
	if (n === 0) return null;
	return 1 - 0.05 ** (1 / n);
}

/** One binary forecast: probability `p` that the event happens, outcome `y`. */
export interface BinaryPoint {
	p: number;
	y: boolean;
}

/** Mean squared error of binary probability forecasts; null without points. */
export function brierBinary(points: readonly BinaryPoint[]): number | null {
	if (points.length === 0) return null;
	const total = points.reduce((sum, { p, y }) => sum + (p - (y ? 1 : 0)) ** 2, 0);
	return total / points.length;
}

/**
 * Multiclass Brier score: the squared error summed over every option of the
 * distribution, averaged over forecasts (0 is perfect, 2 the worst). An option
 * missing from a distribution counts as probability 0.
 */
export function brierMulticlass(
	points: readonly { distribution: Readonly<Record<string, number>>; label: string }[]
): number | null {
	if (points.length === 0) return null;
	let total = 0;
	for (const { distribution, label } of points) {
		const options = new Set([...Object.keys(distribution), label]);
		for (const option of options) {
			total += ((distribution[option] ?? 0) - (option === label ? 1 : 0)) ** 2;
		}
	}
	return total / points.length;
}

/** One bin of a reliability diagram. */
export interface ReliabilityBin {
	/** Inclusive lower edge; the last bin also includes 1. */
	lower: number;
	upper: number;
	count: number;
	/** Mean forecast probability in the bin, null when empty. */
	meanPredicted: number | null;
	/** Observed frequency of the event in the bin, null when empty. */
	observed: number | null;
}

/** Equal-width reliability bins over [0, 1], plus the expected calibration error. */
export function reliability(
	points: readonly BinaryPoint[],
	binCount = 10
): { bins: ReliabilityBin[]; ece: number | null } {
	const sums = Array.from({ length: binCount }, () => ({ count: 0, p: 0, y: 0 }));
	for (const { p, y } of points) {
		const clamped = Math.min(1, Math.max(0, p));
		const index = Math.min(binCount - 1, Math.floor(clamped * binCount));
		const bin = sums[index] as { count: number; p: number; y: number };
		bin.count++;
		bin.p += clamped;
		bin.y += y ? 1 : 0;
	}
	const bins = sums.map((bin, i) => ({
		lower: i / binCount,
		upper: (i + 1) / binCount,
		count: bin.count,
		meanPredicted: bin.count === 0 ? null : bin.p / bin.count,
		observed: bin.count === 0 ? null : bin.y / bin.count,
	}));
	if (points.length === 0) return { bins, ece: null };
	const ece = bins.reduce(
		(sum, bin) =>
			sum +
			(bin.count === 0
				? 0
				: (bin.count / points.length) * Math.abs((bin.meanPredicted ?? 0) - (bin.observed ?? 0))),
		0
	);
	return { bins, ece };
}

/** Rows are the first rater's labels, columns the second's. */
export type Confusion = Record<string, Record<string, number>>;

export function confusion(pairs: readonly (readonly [string, string])[]): Confusion {
	const matrix: Confusion = {};
	for (const [a, b] of pairs) {
		const row = (matrix[a] ??= {});
		row[b] = (row[b] ?? 0) + 1;
	}
	return matrix;
}

/**
 * Cohen's kappa: agreement between two raters beyond what their label
 * frequencies give by chance. Null without pairs, or when chance agreement is
 * already total (both raters used one and the same label throughout).
 */
export function cohensKappa(pairs: readonly (readonly [string, string])[]): number | null {
	if (pairs.length === 0) return null;
	const n = pairs.length;
	const first = new Map<string, number>();
	const second = new Map<string, number>();
	let agree = 0;
	for (const [a, b] of pairs) {
		if (a === b) agree++;
		first.set(a, (first.get(a) ?? 0) + 1);
		second.set(b, (second.get(b) ?? 0) + 1);
	}
	let chance = 0;
	for (const [label, count] of first) chance += (count / n) * ((second.get(label) ?? 0) / n);
	if (chance === 1) return null;
	return (agree / n - chance) / (1 - chance);
}

/** The `q` quantile (0..1) by nearest rank; null for an empty list. */
export function quantile(values: readonly number[], q: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
	return sorted[rank - 1] ?? null;
}

export function mean(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * The highest threshold on `p` whose recall of the positive class is at least
 * `targetRecall`, or null when no threshold reaches it. Fitted on the
 * CALIBRATION split only, then applied to held-out data; fitting and reporting
 * on the same threads would overstate recall.
 */
export function thresholdForRecall(
	points: readonly BinaryPoint[],
	targetRecall: number
): number | null {
	const positives = points.filter((point) => point.y).map((point) => point.p);
	if (positives.length === 0) return null;
	// Recall at threshold t counts positives with p >= t; it falls as t rises,
	// so walk the positive scores from the top until enough are kept.
	const sorted = [...positives].sort((a, b) => b - a);
	const needed = Math.ceil(targetRecall * sorted.length);
	return needed === 0 ? 1 : (sorted[needed - 1] ?? null);
}
