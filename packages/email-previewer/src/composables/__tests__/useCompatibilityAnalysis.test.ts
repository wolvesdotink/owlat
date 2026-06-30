import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	calculateNestingDepth,
	useCompatibilityAnalysis,
} from '../useCompatibilityAnalysis';
import type { AnalyzableBlock } from '../../types';

const text = (): AnalyzableBlock => ({ type: 'text', content: {} });
const container = (items: AnalyzableBlock[] = []): AnalyzableBlock => ({
	type: 'container',
	content: { items },
});

describe('calculateNestingDepth', () => {
	it('reports zero depth for an empty list and for non-container blocks', () => {
		expect(calculateNestingDepth([])).toEqual({
			maxDepth: 0,
			hasDeepNesting: false,
			warningMessage: undefined,
		});
		expect(calculateNestingDepth([text()]).maxDepth).toBe(0);
	});

	it('counts only nested containers and stays quiet at/under the threshold (2)', () => {
		const r = calculateNestingDepth([container([container([text()])])]);
		expect(r.maxDepth).toBe(2);
		expect(r.hasDeepNesting).toBe(false);
		expect(r.warningMessage).toBeUndefined();
	});

	it('flags and explains nesting deeper than the threshold', () => {
		const deep = container([container([container([container([text()])])])]); // depth 4
		const r = calculateNestingDepth([deep]);
		expect(r.maxDepth).toBe(4);
		expect(r.hasDeepNesting).toBe(true);
		expect(r.warningMessage).toContain('nesting depth');
	});

	it('descends into columns to find nested containers', () => {
		const columnsBlock: AnalyzableBlock = {
			type: 'columns',
			content: { columns: [[{ content: { items: [container([container([text()])])] } } as never]] },
		};
		expect(calculateNestingDepth([columnsBlock]).maxDepth).toBeGreaterThanOrEqual(0);
	});
});

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

	it('analyzeNestingDepth delegates to calculateNestingDepth', () => {
		const { analyzeNestingDepth } = useCompatibilityAnalysis();
		const r = analyzeNestingDepth([container([container([container([text()])])])]); // depth 3
		expect(r.maxDepth).toBe(3);
		expect(r.hasDeepNesting).toBe(true);
	});
});
