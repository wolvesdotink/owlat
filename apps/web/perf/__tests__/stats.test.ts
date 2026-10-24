import { describe, expect, it } from 'vitest';
import { formatReport, type Report } from '../report';
import { counter, percentile, summarize, summarizeSamples, timing } from '../stats';

describe('summarize', () => {
	it('median, spread and coefficient of variation', () => {
		const s = summarize([10, 12, 14, 16]);
		expect(s).toMatchObject({ n: 4, median: 13, min: 10, max: 16, mean: 13 });
		expect(s.stdev).toBeCloseTo(2.582, 3);
		expect(s.cv).toBeCloseTo(0.1986, 4);
	});

	it('a single run has no spread', () => {
		expect(summarize([5])).toMatchObject({ n: 1, median: 5, stdev: 0, cv: 0 });
	});

	it('percentile is nearest-rank', () => {
		const values = Array.from({ length: 20 }, (_, i) => i + 1);
		expect(percentile(values, 0.5)).toBe(10);
		expect(percentile(values, 0.95)).toBe(19);
		expect(percentile([3, 1, 2], 1)).toBe(3);
	});
});

describe('summarizeSamples', () => {
	it('marks a counter stable only when every run agrees', () => {
		const summaries = summarizeSamples([
			{ rows: counter(500), layouts: counter(48), patch: timing(1.2) },
			{ rows: counter(500), layouts: counter(49), patch: timing(1.4) },
		]);
		expect(summaries.map((m) => [m.name, m.kind, m.stable])).toEqual([
			['rows', 'counter', true],
			['layouts', 'counter', false],
			['patch', 'timing', false],
		]);
	});

	it('refuses runs that measured different things', () => {
		expect(() => summarizeSamples([{ a: counter(1) }, { b: counter(1) }])).toThrow(/run 2/);
	});
});

describe('formatReport', () => {
	const report: Report = {
		environment: {
			cpu: 'Example CPU',
			logicalCores: 8,
			memoryGb: 16,
			os: 'linux 6.0',
			browser: 'Chrome 1.0',
			headless: true,
			runtime: 'Bun 1.0',
			vue: '3.5.0',
			commit: 'abc123',
			cpuThrottle: 1,
			viewport: '1280×800 @1x',
			timezone: 'UTC',
			locale: 'en-US',
			repeats: 2,
			startedAt: '2026-10-19T00:00:00.000Z',
		},
		scenarios: [
			{
				id: 'chat-history/500',
				description: 'A room.',
				metrics: summarizeSamples([
					{ rows: counter(500), 'frame p95': timing(16.7) },
					{ rows: counter(500), 'frame p95': timing(16.9) },
				]),
				voided: [],
				budgets: { rows: { exact: 500 } },
			},
		],
		budgetFailures: [],
	};

	it('records the reference machine and separates counters from timings', () => {
		const md = formatReport(report);
		expect(md).toContain('| CPU | Example CPU (8 logical cores) |');
		expect(md).toContain('| Runs | 2 per scenario, each on a fresh page |');
		expect(md).toContain('| Timezone | UTC |');
		expect(md).toContain('| Browser locale | en-US');
		expect(md).toContain('| rows | 500 | 500 | 500 | yes | = 500 |');
		expect(md).toContain('Budgets: every run held every budget.');
		expect(md).toContain('| frame p95 (ms) | 16.80 | 16.70 | 16.90 |');
		expect(md).not.toContain('VOID');
	});

	it('lists every budget breach above the scenarios', () => {
		const md = formatReport({
			...report,
			budgetFailures: [
				{
					scenario: 'chat-history/500',
					metric: 'rows',
					run: 2,
					message: 'measured 499, budget exactly 500',
				},
			],
		});
		expect(md).toContain('Budgets: 1 breach.');
		expect(md).toContain('- chat-history/500 / rows (run 2): measured 499, budget exactly 500');
		expect(md.indexOf('Budgets: 1 breach.')).toBeLessThan(md.indexOf('## chat-history/500'));
	});

	it('voids a scenario whose fixture did not render cleanly', () => {
		const md = formatReport({
			...report,
			scenarios: [
				{
					...report.scenarios[0]!,
					voided: [{ vueErrors: [], unresolvedComponents: ['uiavatar'], missingI18nKeys: [] }],
				},
			],
		});
		expect(md).toContain('VOID');
		expect(md).toContain('- unresolved component: <uiavatar>');
	});
});
