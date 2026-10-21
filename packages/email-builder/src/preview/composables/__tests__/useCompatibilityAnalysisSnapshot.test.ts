import { describe, it, expect, afterEach, vi } from 'vitest';
import { emailClients } from '../../data/clients';

/**
 * Issue #1434: the web CSP blocks caniemail.com, so the analysis must not need
 * it. With the network refused and nothing cached, the real bundled snapshot
 * still drives the findings (no mocks of the data here).
 */
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('useCompatibilityAnalysis with the bundled Can I Email snapshot', () => {
	it('reports snapshot-backed findings for Outlook (Windows) with the network refused', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
		vi.stubGlobal('fetch', fetchMock);
		vi.resetModules();
		const { useCompatibilityAnalysis } = await import('../useCompatibilityAnalysis');
		const { analyzeHtml } = useCompatibilityAnalysis();
		const outlookWindows = emailClients.find((c) => c.id === 'outlook-windows')!;

		const result = await analyzeHtml('<div style="border-radius: 8px">Hello</div>', {
			clients: [outlookWindows],
		});

		expect(fetchMock).not.toHaveBeenCalled();
		const features = result!.issues.map((i) => i.feature);
		expect(features).not.toContain('caniemail-data');
		const borderRadius = result!.issues.find((i) => i.feature === 'css-border-radius');
		expect(borderRadius?.clients).toEqual(['Outlook (Windows)']);
		expect(borderRadius?.cssProperty).toBe('border-radius');
	});
});
