/**
 * Statistics and the Markdown report for `bun run perf:bench` (plan item
 * OW-072). Pure functions over the raw samples the measurement specs write
 * (see sample.ts), so the arithmetic is unit-tested apart from any timing.
 *
 * Two levels of variance are reported, because they answer different
 * questions:
 * - within a run: the median and p95 of one process's samples (how steady the
 *   operation is once warm);
 * - across runs: the spread of the per-run medians over N separate processes
 *   (how far one run on this machine can be trusted). A difference between two
 *   commits smaller than this spread is noise.
 *
 * Nothing here compares a number against a threshold: the report states what
 * was measured and on what, and never passes or fails.
 */
import type { FamilyResult } from './sample';

/** Linear-interpolation quantile (type 7, as in R and NumPy) of unsorted values. */
export function quantile(values: readonly number[], q: number): number {
	if (values.length === 0) throw new Error('quantile of an empty list');
	if (q < 0 || q > 1) throw new Error(`quantile out of range: ${q}`);
	const sorted = [...values].sort((a, b) => a - b);
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	const loValue = sorted[lo] as number;
	const hiValue = sorted[hi] as number;
	return loValue + (hiValue - loValue) * (pos - lo);
}

export interface RunSummary {
	median: number;
	p95: number;
	mean: number;
	samples: number;
}

/** One process's samples of one task. */
export function summarizeRun(samplesMs: readonly number[]): RunSummary {
	const mean = samplesMs.reduce((sum, v) => sum + v, 0) / samplesMs.length;
	return {
		median: quantile(samplesMs, 0.5),
		p95: quantile(samplesMs, 0.95),
		mean,
		samples: samplesMs.length,
	};
}

export interface TaskAggregate {
	name: string;
	runs: number;
	samplesPerRun: number;
	opsPerSample: number;
	/** Median over runs of each run's median. */
	median: number;
	/** Median over runs of each run's p95. */
	p95: number;
	/** Smallest and largest per-run median. */
	runMedianMin: number;
	runMedianMax: number;
	/** (max - min) / median of the per-run medians, in percent. */
	spreadPct: number;
	/** Coefficient of variation of the per-run medians, in percent. */
	cvPct: number;
}

/** Combine the same task across N runs. Every run must contain every task. */
export function aggregateTask(name: string, runs: readonly FamilyResult[]): TaskAggregate {
	const perRun = runs.map((run) => {
		const task = run.tasks.find((t) => t.name === name);
		if (!task) throw new Error(`task "${name}" missing from a run of ${run.family}`);
		return { task, summary: summarizeRun(task.samplesMs) };
	});
	const medians = perRun.map((r) => r.summary.median);
	const median = quantile(medians, 0.5);
	const mean = medians.reduce((sum, v) => sum + v, 0) / medians.length;
	const variance =
		medians.length > 1
			? medians.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (medians.length - 1)
			: 0;
	const runMedianMin = Math.min(...medians);
	const runMedianMax = Math.max(...medians);
	const first = perRun[0];
	if (!first) throw new Error(`no runs for task "${name}"`);
	const sampling = (r: (typeof perRun)[number]) => `${r.summary.samples}x${r.task.opsPerSample}`;
	if (perRun.some((r) => sampling(r) !== sampling(first))) {
		throw new Error(`task "${name}" was sampled differently across runs`);
	}
	return {
		name,
		runs: perRun.length,
		samplesPerRun: first.summary.samples,
		opsPerSample: first.task.opsPerSample,
		median,
		p95: quantile(
			perRun.map((r) => r.summary.p95),
			0.5
		),
		runMedianMin,
		runMedianMax,
		spreadPct: median > 0 ? ((runMedianMax - runMedianMin) / median) * 100 : 0,
		cvPct: mean > 0 ? (Math.sqrt(variance) / mean) * 100 : 0,
	};
}

/** Every task of one family, in the order the first run lists them. */
export function aggregateFamily(runs: readonly FamilyResult[]): TaskAggregate[] {
	const first = runs[0];
	if (!first) return [];
	return first.tasks.map((task) => aggregateTask(task.name, runs));
}

/** A duration in the unit that keeps three or four significant digits. */
export function formatDuration(ms: number): string {
	if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
	if (ms >= 1) return `${ms.toFixed(2)} ms`;
	return `${(ms * 1000).toFixed(1)} µs`;
}

export interface ReportContext {
	/** The `--machine` name: the reference hardware the numbers belong to. */
	machine: string;
	cpu: string;
	cores: number;
	memoryGiB: number;
	os: string;
	cpuGovernor: string;
	bun: string;
	vitest: string;
	commit: string;
	startedAt: string;
	loadBefore: string;
	loadAfter: string;
}

/** The Markdown report: environment, then one table per family. */
export function renderReport(
	context: ReportContext,
	families: ReadonlyArray<{ runs: readonly FamilyResult[] }>
): string {
	const lines: string[] = [
		'# Owlat hot-path benchmark (report-only)',
		'',
		`- Machine: ${context.machine}`,
		`- CPU: ${context.cpu}, ${context.cores} logical cores, governor ${context.cpuGovernor}`,
		`- Memory: ${context.memoryGiB} GiB; OS: ${context.os}`,
	];
	const first = families[0]?.runs[0];
	if (first) {
		lines.push(
			`- Engine: Node ${first.runtime.node} (V8 ${first.runtime.v8}), vitest ${context.vitest}`
		);
	}
	lines.push(
		`- Driver: Bun ${context.bun}; commit ${context.commit}; started ${context.startedAt}`,
		`- Load average (1/5/15 min) before: ${context.loadBefore}; after: ${context.loadAfter}`,
		''
	);
	for (const { runs } of families) {
		const head = runs[0];
		if (!head) continue;
		lines.push(`## ${head.family}: ${head.title}`, '');
		for (const [key, value] of Object.entries(head.dataset)) lines.push(`- ${key}: ${value}`);
		const tasks = aggregateFamily(runs);
		lines.push(
			'',
			`${tasks[0]?.runs ?? 0} separate processes. "Sampling" is each process's timed samples ` +
				'times the calls per sample, after warm-up. Median and p95 are per process, then the ' +
				'median over processes; the last three columns are the run-to-run variance of the ' +
				'per-process medians.',
			'',
			'| task | sampling | median | p95 | run medians (min to max) | spread | CV |',
			'| --- | ---: | ---: | ---: | ---: | ---: | ---: |'
		);
		for (const t of tasks) {
			lines.push(
				`| ${t.name} | ${t.samplesPerRun} × ${t.opsPerSample} | ${formatDuration(t.median)} | ` +
					`${formatDuration(t.p95)} | ` +
					`${formatDuration(t.runMedianMin)} to ${formatDuration(t.runMedianMax)} | ` +
					`${t.spreadPct.toFixed(1)}% | ${t.cvPct.toFixed(1)}% |`
			);
		}
		lines.push('');
	}
	lines.push(
		'Report-only: no number above is compared against a budget. Compare two commits only on ' +
			'the same machine, and treat any difference inside the run-to-run spread as noise.',
		''
	);
	return lines.join('\n');
}
