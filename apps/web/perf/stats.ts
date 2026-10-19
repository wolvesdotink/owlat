/**
 * Measurement records and the repeated-run summary the report prints.
 *
 * Two kinds of number, kept apart on purpose. A `counter` is work the browser
 * or Vue did (component updates, DOM mutations, layouts, nodes left after
 * teardown): it should come out the same on every run, and the summary says
 * whether it did. A `timing` is wall-clock and machine-bound: it is reported
 * with its spread and never compared against a threshold.
 */

type MetricKind = 'counter' | 'timing';

interface Metric {
	kind: MetricKind;
	unit: string;
	value: number;
}

/** One run of one scenario: metric name to value. */
export type Sample = Record<string, Metric>;

export const counter = (value: number, unit = 'count'): Metric => ({
	kind: 'counter',
	unit,
	value,
});
export const timing = (value: number, unit = 'ms'): Metric => ({ kind: 'timing', unit, value });

interface Summary {
	n: number;
	median: number;
	min: number;
	max: number;
	mean: number;
	/** Sample standard deviation (n − 1); 0 for a single run. */
	stdev: number;
	/** stdev / mean; 0 when the mean is 0. */
	cv: number;
}

/** The value at fraction `p` of the sorted list (nearest rank). */
export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[rank] as number;
}

export function summarize(values: readonly number[]): Summary {
	const n = values.length;
	if (n === 0) {
		return {
			n: 0,
			median: Number.NaN,
			min: Number.NaN,
			max: Number.NaN,
			mean: Number.NaN,
			stdev: Number.NaN,
			cv: Number.NaN,
		};
	}
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(n / 2);
	const median =
		n % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
	const mean = values.reduce((sum, v) => sum + v, 0) / n;
	const variance = n > 1 ? values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1) : 0;
	const stdev = Math.sqrt(variance);
	return {
		n,
		median,
		min: sorted[0] as number,
		max: sorted[n - 1] as number,
		mean,
		stdev,
		cv: mean === 0 ? 0 : stdev / Math.abs(mean),
	};
}

export interface MetricSummary extends Summary {
	name: string;
	kind: MetricKind;
	unit: string;
	/** Every run produced the same value: true for a counter that is deterministic. */
	stable: boolean;
}

/**
 * Summarize each metric across the runs of one scenario. A metric missing from
 * a run is an error: the runs did not measure the same thing.
 */
export function summarizeSamples(samples: readonly Sample[]): MetricSummary[] {
	const first = samples[0];
	if (!first) return [];
	const names = Object.keys(first);
	for (const [i, sample] of samples.entries()) {
		const missing = names.filter((name) => !(name in sample));
		if (missing.length > 0 || Object.keys(sample).length !== names.length) {
			throw new Error(
				`run ${i + 1} measured a different metric set (missing: ${missing.join(', ')})`
			);
		}
	}
	return names.map((name) => {
		const { kind, unit } = first[name] as Metric;
		const values = samples.map((s) => (s[name] as Metric).value);
		const summary = summarize(values);
		return { name, kind, unit, ...summary, stable: summary.min === summary.max };
	});
}
