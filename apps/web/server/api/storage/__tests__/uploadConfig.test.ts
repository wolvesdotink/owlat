// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tailwindcss/vite', () => ({ default: () => [] }));
vi.mock('../../../../scripts/uiLayerIcons', () => ({ uiLayerIconNames: () => [] }));
afterEach(() => vi.unstubAllGlobals());

describe('upload middleware configuration', () => {
	it('keeps body-consuming middleware off the capability-authenticated upload route', async () => {
		vi.stubGlobal('defineNuxtConfig', (config: unknown) => config);
		const { default: config } = await import('../../../../nuxt.config');
		expect(config.routeRules?.['/api/storage/upload']).toMatchObject({
			csurf: false,
			security: { requestSizeLimiter: false, xssValidator: false },
		});
		// Other routes retain the application's normal request protection.
		expect(config.security?.xssValidator).not.toBe(false);
		expect(config.security?.requestSizeLimiter).not.toBe(false);
	});
});
