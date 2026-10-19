import { describe, it, expect, vi } from 'vitest';
import { computed, ref, toRaw } from 'vue';

/**
 * The data load is replaced by per-call controlled promises so the first
 * analysis can be made to resolve after the second: the stale-overwrite order
 * the generation token exists for, independent of how fetchData dedupes.
 */
const loads: Array<() => void> = [];
vi.mock('../useCanIEmail', () => ({
	useCanIEmail: () => ({
		fetchData: () =>
			new Promise<void>((resolve) => {
				loads.push(resolve);
			}),
		getFeatureBySlug: () => undefined,
		getFeatureSupport: () => null,
		features: computed(() => []),
		error: ref(null),
	}),
}));

const { useCompatibilityAnalysis } = await import('../useCompatibilityAnalysis');

describe('useCompatibilityAnalysis — latest only', () => {
	it('a slow first analysis resolving after a newer one does not overwrite it', async () => {
		loads.length = 0;
		const { analyzeHtml, report, isAnalyzing } = useCompatibilityAnalysis();

		const slow = analyzeHtml('<div style="display: flex"></div>');
		const fast = analyzeHtml('<div style="display: grid"></div>');
		const [resolveSlow, resolveFast] = loads;

		resolveFast!();
		const newest = await fast;
		expect(newest).not.toBeNull();
		expect(toRaw(report.value)).toBe(newest);
		expect(isAnalyzing.value).toBe(false);

		resolveSlow!();
		expect(await slow).toBeNull();
		expect(toRaw(report.value)).toBe(newest);
		expect(report.value!.issues.map((i) => i.feature)).toContain('css-display-grid');
		expect(report.value!.issues.map((i) => i.feature)).not.toContain('css-display-flex');
		expect(isAnalyzing.value).toBe(false);
	});

	it('a superseded analysis settling first leaves the newer one loading', async () => {
		loads.length = 0;
		const { analyzeHtml, report, isAnalyzing } = useCompatibilityAnalysis();

		const older = analyzeHtml('<div style="display: flex"></div>');
		const newer = analyzeHtml('<div style="display: grid"></div>');
		const [resolveOlder, resolveNewer] = loads;

		resolveOlder!();
		expect(await older).toBeNull();
		expect(report.value).toBeNull();
		expect(isAnalyzing.value).toBe(true);

		resolveNewer!();
		expect(await newer).toBe(toRaw(report.value));
		expect(isAnalyzing.value).toBe(false);
	});
});
