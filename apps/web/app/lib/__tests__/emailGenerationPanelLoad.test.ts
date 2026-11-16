/**
 * The generator's chunk is fetched once and shared, but a failed fetch must
 * not be: the loader's "Try again" has to make a new request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const PANEL = '~/components/ai/EmailGeneratePanel.vue';

afterEach(() => {
	vi.doUnmock(PANEL);
	vi.resetModules();
});

describe('loadEmailGeneratePanel', () => {
	it('fetches the panel once for every caller', async () => {
		const panel = { name: 'EmailGeneratePanel' };
		const factory = vi.fn(() => ({ default: panel }));
		vi.doMock(PANEL, factory);
		const { loadEmailGeneratePanel } = await import('~/lib/emailGenerationEntry');

		const [first, second] = await Promise.all([loadEmailGeneratePanel(), loadEmailGeneratePanel()]);

		expect(first).toBe(panel);
		expect(second).toBe(panel);
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it('forgets a failed fetch, so the next call asks again', async () => {
		vi.doMock(PANEL, () => {
			throw new TypeError('Failed to fetch dynamically imported module');
		});
		const { loadEmailGeneratePanel } = await import('~/lib/emailGenerationEntry');
		const failed = loadEmailGeneratePanel();
		await expect(failed).rejects.toThrow();

		expect(loadEmailGeneratePanel()).not.toBe(failed);
	});

	it('leaves a failed warm-up for the loader to report', async () => {
		vi.doMock(PANEL, () => {
			throw new TypeError('offline');
		});
		const { warmEmailGeneratePanel, loadEmailGeneratePanel } =
			await import('~/lib/emailGenerationEntry');

		expect(() => warmEmailGeneratePanel()).not.toThrow();
		await expect(loadEmailGeneratePanel()).rejects.toThrow();
	});
});
