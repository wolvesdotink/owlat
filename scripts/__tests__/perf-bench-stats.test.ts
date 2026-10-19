import { describe, expect, it } from 'vitest';
import type { FamilyResult } from '../perf-bench/sample';
import {
	aggregateFamily,
	formatDuration,
	quantile,
	renderReport,
	summarizeRun,
	type ReportContext,
} from '../perf-bench/stats';

function run(tasks: Record<string, number[]>): FamilyResult {
	return {
		family: 'demo',
		title: 'demo family',
		dataset: { rows: 50 },
		runtime: { node: 'v24.0.0', v8: '13.0' },
		tasks: Object.entries(tasks).map(([name, samplesMs]) => ({ name, opsPerSample: 1, samplesMs })),
	};
}

const context: ReportContext = {
	machine: 'reference box',
	cpu: 'Example CPU',
	cores: 8,
	memoryGiB: 32,
	os: 'linux 6.0 x64',
	cpuGovernor: 'performance',
	bun: '1.3.0',
	vitest: '4.1.11',
	commit: 'abc123',
	startedAt: '2026-10-19T12:00:00.000Z',
	loadBefore: '0.10 / 0.20 / 0.30',
	loadAfter: '0.40 / 0.50 / 0.60',
};

describe('quantile', () => {
	it('interpolates linearly between ranks, whatever the input order', () => {
		expect(quantile([3, 1, 2, 4], 0.5)).toBe(2.5);
		expect(quantile([10, 20, 30, 40, 50], 0.95)).toBeCloseTo(48);
		expect(quantile([7], 0.95)).toBe(7);
		expect(quantile([1, 2, 3], 0)).toBe(1);
		expect(quantile([1, 2, 3], 1)).toBe(3);
	});

	it('refuses an empty list and an out-of-range quantile', () => {
		expect(() => quantile([], 0.5)).toThrow(/empty/);
		expect(() => quantile([1], 1.5)).toThrow(/out of range/);
	});
});

describe('summarizeRun', () => {
	it('reports the median, p95 and mean of one process', () => {
		const samples = Array.from({ length: 100 }, (_, i) => i + 1);
		expect(summarizeRun(samples)).toEqual({ median: 50.5, p95: 95.05, mean: 50.5, samples: 100 });
	});
});

describe('aggregateFamily', () => {
	it('takes the median over runs and reports the run-to-run spread', () => {
		const runs = [run({ a: [1, 1, 1] }), run({ a: [2, 2, 2] }), run({ a: [4, 4, 4] })];
		const [a] = aggregateFamily(runs);
		expect(a).toMatchObject({
			name: 'a',
			runs: 3,
			samplesPerRun: 3,
			median: 2,
			p95: 2,
			runMedianMin: 1,
			runMedianMax: 4,
			spreadPct: 150,
		});
		// Sample standard deviation of 1, 2, 4 over their mean 7/3.
		expect(a?.cvPct).toBeCloseTo((Math.sqrt(7 / 3) / (7 / 3)) * 100);
	});

	it('reports no variance for a single run', () => {
		const [a] = aggregateFamily([run({ a: [5, 5] })]);
		expect(a).toMatchObject({ runs: 1, spreadPct: 0, cvPct: 0 });
	});

	it('keeps the task order of the first run and fails when a run lacks a task', () => {
		expect(
			aggregateFamily([run({ b: [1], a: [1] }), run({ a: [1], b: [1] })]).map((t) => t.name)
		).toEqual(['b', 'a']);
		expect(() => aggregateFamily([run({ a: [1] }), run({ b: [1] })])).toThrow(/task "a" missing/);
	});
});

describe('formatDuration', () => {
	it('picks a unit that keeps the digits readable', () => {
		expect(formatDuration(0.0123)).toBe('12.3 µs');
		expect(formatDuration(4.567)).toBe('4.57 ms');
		expect(formatDuration(2500)).toBe('2.50 s');
	});
});

describe('renderReport', () => {
	const report = renderReport(context, [{ runs: [run({ a: [1, 2, 3] }), run({ a: [2, 3, 4] })] }]);

	it('names the machine, the software and the load around the runs', () => {
		expect(report).toContain('Machine: reference box');
		expect(report).toContain('Example CPU, 8 logical cores, governor performance');
		expect(report).toContain('Node v24.0.0 (V8 13.0), vitest 4.1.11');
		expect(report).toContain('commit abc123');
		expect(report).toContain('before: 0.10 / 0.20 / 0.30; after: 0.40 / 0.50 / 0.60');
	});

	it('lists the dataset and one row per task with its variance', () => {
		expect(report).toContain('## demo: demo family');
		expect(report).toContain('- rows: 50');
		expect(report).toContain('2 separate processes; per process 3 samples of 1 call(s)');
		expect(report).toContain('| a | 2.50 ms | 3.40 ms | 2.00 ms to 3.00 ms | 40.0% | 28.3% |');
	});

	it('states that nothing is gated', () => {
		expect(report).toContain('Report-only: no number above is compared against a budget.');
	});
});
