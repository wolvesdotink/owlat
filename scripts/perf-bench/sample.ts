/**
 * In-process sampling for the report-only hot-path benchmarks (plan item
 * OW-072). A measurement file is an ordinary vitest spec whose timing block
 * runs only when `OWLAT_PERF_BENCH_OUT` names an output file, which only
 * `bun run perf:bench` (scripts/perf-bench/run.ts) sets. CI never sets it, so
 * the timing block is skipped there and nothing gates on wall-clock time.
 * (turbo passes `OWLAT_*` variables through to tasks, so a shell that exported
 * it would reach a `turbo test` run too; nothing exports it but the driver.)
 *
 * Sampling is fixed-count rather than time-boxed: every run does the same
 * number of operations, so two runs differ only in how long the machine took.
 * The raw per-sample timings go to the output file; every statistic is computed
 * by the driver, across separate processes (see stats.ts).
 *
 * Zero dependencies beyond node:fs, so a spec in any workspace can import it.
 */
import { writeFileSync } from 'node:fs';

export const PERF_BENCH_OUT_ENV = 'OWLAT_PERF_BENCH_OUT';

/** The output file the driver asked for, or undefined when no benchmark run is active. */
export function perfBenchOutput(): string | undefined {
	return process.env[PERF_BENCH_OUT_ENV] || undefined;
}

export interface SampleOptions {
	/** Untimed calls before sampling, so the timed calls run on optimized code. */
	warmup: number;
	/** Timed samples. */
	samples: number;
	/** Calls per sample; raise it until one sample is well above timer resolution. */
	opsPerSample: number;
}

export interface TaskSamples {
	name: string;
	opsPerSample: number;
	/** Milliseconds per call, one entry per sample, in sampling order. */
	samplesMs: number[];
}

/** What one measurement process writes for one benchmark family. */
export interface FamilyResult {
	family: string;
	title: string;
	/** Fixture description: sizes, shapes and the source each limit comes from. */
	dataset: Record<string, string | number>;
	runtime: { node: string; v8: string };
	tasks: TaskSamples[];
}

// Every result lands here, so the engine cannot prove a call useless and drop it.
let sink: unknown;

/** Time `run` with a fixed number of warm-up calls, samples and calls per sample. */
export function sampleTask(name: string, run: () => unknown, options: SampleOptions): TaskSamples {
	for (let i = 0; i < options.warmup; i++) sink = run();
	const samplesMs: number[] = [];
	for (let s = 0; s < options.samples; s++) {
		const start = performance.now();
		for (let i = 0; i < options.opsPerSample; i++) sink = run();
		samplesMs.push((performance.now() - start) / options.opsPerSample);
	}
	return { name, opsPerSample: options.opsPerSample, samplesMs };
}

/** Write one family's samples for the driver, with the engine that produced them. */
export function writeFamilyResult(path: string, result: Omit<FamilyResult, 'runtime'>): void {
	const full: FamilyResult = {
		...result,
		runtime: { node: process.version, v8: process.versions.v8 },
	};
	// The sink is read here, once, so its stores count as observable.
	if (sink === full) throw new Error('unreachable');
	writeFileSync(path, JSON.stringify(full));
}
