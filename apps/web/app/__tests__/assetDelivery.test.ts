// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What every page downloads, and how: the global stylesheet list, Nitro's
 * precompressed assets and NuxtLink's prefetch trigger. All three are build
 * configuration, so each is pinned against the real nuxt.config.
 */

vi.mock('@tailwindcss/vite', () => ({ default: () => [] }));
vi.mock('../../scripts/uiLayerIcons', () => ({ uiLayerIconNames: () => [] }));

const here = dirname(fileURLToPath(import.meta.url));
const builderSrc = resolve(here, '..', '..', '..', '..', 'packages', 'email-builder', 'src');

async function loadConfig(env: { desktop: boolean }) {
	vi.resetModules();
	vi.stubGlobal('defineNuxtConfig', (config: unknown) => config);
	vi.stubEnv('OWLAT_DESKTOP', env.desktop ? 'true' : '');
	const { default: config } = await import('../../nuxt.config');
	return config;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe('global stylesheets', () => {
	it('ships only the app stylesheet on every page, not the email builder styles', async () => {
		const config = await loadConfig({ desktop: false });
		expect(config.css).toEqual(['~/assets/css/main.css']);
	});

	it('loads the builder and previewer styles from the components that need them', () => {
		const builder = readFileSync(resolve(builderSrc, 'components', 'EmailBuilder.vue'), 'utf8');
		const previewer = readFileSync(
			resolve(builderSrc, 'preview', 'components', 'EmailPreviewer.vue'),
			'utf8'
		);
		expect(builder).toContain("import '../styles/utilities.css';");
		expect(previewer).toContain("import '../styles/variables.css';");
	});

	it("keeps the host's --ep-* mapping ahead of the previewer defaults that now load later", () => {
		// main.css maps --ep-* onto the design tokens on plain `:root`. The
		// previewer's stylesheet arrives with its chunk, AFTER main.css, so its
		// dark defaults must carry no specificity or they would override the
		// mapping. The light overrides keep `:root.light`, which already beat the
		// mapping when the file was global.
		const vars = readFileSync(resolve(builderSrc, 'preview', 'styles', 'variables.css'), 'utf8');
		expect(vars).toMatch(/^:where\(:root\) \{/m);
		expect(vars).not.toMatch(/^:root \{/m);
		expect(vars).toMatch(/^:root\.light \{/m);
	});
});

describe('precompressed public assets', () => {
	it('emits gzip and brotli variants for the web build', async () => {
		const config = await loadConfig({ desktop: false });
		expect(config.nitro?.compressPublicAssets).toEqual({ gzip: true, brotli: true });
	});

	it('keeps them out of the desktop bundle, which Tauri serves without content negotiation', async () => {
		const config = await loadConfig({ desktop: true });
		expect(config.nitro?.compressPublicAssets).toBe(false);
	});
});

describe('route prefetching', () => {
	it('prefetches a route on hover or focus of its link, not when the link becomes visible', async () => {
		const config = await loadConfig({ desktop: false });
		expect(config.experimental?.defaults?.nuxtLink?.prefetchOn).toEqual({
			visibility: false,
			interaction: true,
		});
	});
});
