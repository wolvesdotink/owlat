import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { toRaw } from 'vue';
import { useCompatibilityAnalysis } from '../useCompatibilityAnalysis';
import type { CanIEmailData, CanIEmailFeature } from '../../types';

describe('useCompatibilityAnalysis', () => {
	beforeEach(() => {
		// caniemail data unavailable → deterministic heuristic-only path (no network).
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, statusText: 'offline' }));
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('analyzeHtml returns a scored report and surfaces the no-data warning', async () => {
		const { analyzeHtml, report, issues, score } = useCompatibilityAnalysis();
		const html = `<div style="position: absolute; box-shadow: 0 0 5px #000; animation: a 1s;">
			<video src="x.mp4"></video><form action="/x"><input name="q"></form></div>`;
		const result = await analyzeHtml(html);

		expect(result).not.toBeNull();
		expect(typeof result!.score).toBe('number');
		expect(result!.score).toBeGreaterThanOrEqual(0);
		expect(result!.score).toBeLessThanOrEqual(100);
		expect(Array.isArray(result!.issues)).toBe(true);
		// the reactive refs are populated from the same report
		expect(report.value).toEqual(result);
		expect(issues.value).toEqual(result!.issues);
		expect(score.value).toBe(result!.score);
		// heuristic-only marker present when caniemail data can't be loaded
		expect(result!.issues.some((i) => i.feature === 'caniemail-data')).toBe(true);
	});
});

describe('useCompatibilityAnalysis — overlapping analyses during the first data load', () => {
	const feature = (slug: string): CanIEmailFeature => ({
		slug,
		title: slug,
		description: '',
		url: '',
		category: 'css',
		keywords: '',
		last_test_date: '',
		test_url: '',
		test_results_url: '',
		notes: '',
		notes_by_num: {},
		stats: { gmail: { 'desktop-webmail': { '1': 'n' } } },
	});
	const data: CanIEmailData = {
		api_version: '1.0',
		last_update_date: '2026-06-03',
		nicenames: { family: {}, platform: {}, support: {}, category: {} },
		data: [feature('css-display-flex'), feature('css-display-grid')],
	};

	let respond!: () => void;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn(
			() =>
				new Promise((resolve) => {
					respond = () => resolve({ ok: true, statusText: 'OK', json: async () => data });
				})
		);
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	// A fresh module graph per test: the caniemail cache is module-level.
	async function freshAnalysis() {
		vi.resetModules();
		const mod = await import('../useCompatibilityAnalysis');
		return mod.useCompatibilityAnalysis();
	}

	it('publishes only the newest report, from one shared fetch with the data loaded', async () => {
		const { analyzeHtml, report, isAnalyzing } = await freshAnalysis();
		const reports: unknown[] = [];

		const first = analyzeHtml('<div style="display: flex"></div>');
		const second = analyzeHtml('<div style="display: grid"></div>');
		await Promise.resolve();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// Nothing publishes before the shared load resolves.
		expect(report.value).toBeNull();
		expect(isAnalyzing.value).toBe(true);

		respond();
		reports.push(await first, await second);

		expect(reports[0]).toBeNull();
		expect(reports[1]).toBe(toRaw(report.value));
		const features = report.value!.issues.map((i) => i.feature);
		expect(features).toContain('css-display-grid');
		expect(features).not.toContain('css-display-flex');
		// The newer analysis waited for the data instead of going heuristic-only.
		expect(features).not.toContain('caniemail-data');
		expect(isAnalyzing.value).toBe(false);
	});

	it('cancelAnalysis drops the analysis in flight', async () => {
		const { analyzeHtml, cancelAnalysis, report, isAnalyzing } = await freshAnalysis();

		const pending = analyzeHtml('<div style="display: grid"></div>');
		expect(isAnalyzing.value).toBe(true);
		cancelAnalysis();
		expect(isAnalyzing.value).toBe(false);

		respond();
		expect(await pending).toBeNull();
		expect(report.value).toBeNull();
		expect(isAnalyzing.value).toBe(false);
	});
});
