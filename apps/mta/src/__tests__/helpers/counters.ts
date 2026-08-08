/**
 * Assertion helpers for prom-client counters.
 *
 * A `Counter` with a label produces one `values` entry per label combination,
 * so "how many times did this happen for label X" is always the same three
 * steps: read the metric, keep the entries carrying that label value, sum. Every
 * suite that asserts on a labelled counter was writing its own copy of those
 * three steps; this is the one copy.
 */

import type { Counter } from 'prom-client';

/**
 * Total value of `counter` across every series whose `labelName` equals
 * `labelValue`.
 *
 * Returns 0 when the label value has never been observed, which is exactly what
 * a "this outcome did not happen" assertion wants — prom-client does not
 * materialise a series until it is first incremented.
 */
export async function counterTotal<TLabel extends string>(
	counter: Counter<TLabel>,
	labelName: TLabel,
	labelValue: string
): Promise<number> {
	const metric = await counter.get();
	return metric.values
		.filter((value) => value.labels[labelName] === labelValue)
		.reduce((sum, value) => sum + value.value, 0);
}
