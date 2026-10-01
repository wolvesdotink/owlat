import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useCompatibilityAnalysis } from '../useCompatibilityAnalysis';

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

		expect(typeof result.score).toBe('number');
		expect(result.score).toBeGreaterThanOrEqual(0);
		expect(result.score).toBeLessThanOrEqual(100);
		expect(Array.isArray(result.issues)).toBe(true);
		// the reactive refs are populated from the same report
		expect(report.value).toEqual(result);
		expect(issues.value).toEqual(result.issues);
		expect(score.value).toBe(result.score);
		// heuristic-only marker present when caniemail data can't be loaded
		expect(result.issues.some((i) => i.feature === 'caniemail-data')).toBe(true);
	});
});
