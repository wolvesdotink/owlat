// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POSTBOX_BODY_META_CSP } from '~/utils/postboxBodyPlaceholder';
import { sentPreviewSrcdoc } from '~/utils/postboxSentPreview';

/**
 * The page CSP (nuxt-security, nuxt.config.ts) against what the app loads.
 *
 * The attachment lightbox, the composer's chip thumbnails and pasted-image
 * previews, and the upload dimension probes all load `blob:` URLs the page
 * creates itself. A policy that leaves `blob:` out refuses every one of them
 * silently: a broken image, a PDF fallback, an upload stored without its size
 * (#1292). The same file sets the strict directives, so both are pinned here.
 */

vi.mock('@tailwindcss/vite', () => ({ default: () => [] }));
vi.mock('../../scripts/uiLayerIcons', () => ({ uiLayerIconNames: () => [] }));

const here = dirname(fileURLToPath(import.meta.url));

type Csp = Record<string, unknown>;

async function loadCsp(env: { desktop: boolean }): Promise<Csp> {
	vi.resetModules();
	vi.stubGlobal('defineNuxtConfig', (config: unknown) => config);
	vi.stubEnv('OWLAT_DESKTOP', env.desktop ? 'true' : '');
	const { default: config } = await import('../../nuxt.config');
	return (config as { security: { headers: { contentSecurityPolicy: Csp } } }).security.headers
		.contentSecurityPolicy;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe.each([
	{ build: 'web', desktop: false },
	{ build: 'desktop', desktop: true },
])('page CSP ($build build)', ({ desktop }) => {
	it('lets images load from the blob: URLs the page creates', async () => {
		const csp = await loadCsp({ desktop });
		expect(csp['img-src']).toEqual(["'self'", 'data:', 'https:', 'blob:']);
	});

	it('lets the PDF preview load from blob:, and nothing else into an object or frame', async () => {
		// Chrome checks both directives for `<object data="blob:…" type="application/pdf">`.
		const csp = await loadCsp({ desktop });
		expect(csp['object-src']).toEqual(['blob:']);
		expect(csp['frame-src']).toEqual(['blob:']);
	});

	it('keeps the other directives as strict as they were', async () => {
		const csp = await loadCsp({ desktop });
		expect(csp['base-uri']).toEqual(["'none'"]);
		expect(csp['form-action']).toEqual(["'self'"]);
		expect(csp['script-src-attr']).toEqual(["'none'"]);
		expect(csp['worker-src']).toEqual(["'self'"]);
		expect(csp['font-src']).toEqual(["'self'", 'https:', 'data:']);
		expect(csp['style-src']).toEqual(["'self'", 'https:', "'unsafe-inline'"]);
		expect(csp['default-src']).toBeUndefined();
	});

	it('allows blob: only where a feature needs it, and no wildcard anywhere', async () => {
		const csp = await loadCsp({ desktop });
		const withBlob = Object.entries(csp)
			.filter(([, sources]) => Array.isArray(sources) && sources.includes('blob:'))
			.map(([directive]) => directive)
			.sort();
		expect(withBlob).toEqual(['frame-src', 'img-src', 'object-src']);
		for (const [directive, sources] of Object.entries(csp)) {
			if (!Array.isArray(sources)) continue;
			expect(sources, directive).not.toContain('*');
			expect(sources, directive).not.toContain("'unsafe-eval'");
		}
	});
});

describe('page CSP (web build) script-src', () => {
	it('stays nonce-based with no host or inline allowance', async () => {
		const csp = await loadCsp({ desktop: false });
		expect(csp['script-src']).toEqual(["'self'", "'nonce-{{nonce}}'"]);
	});
});

describe('the policies of the frames that render mail', () => {
	// Untrusted mail and the sender's own markup render in srcdoc frames that
	// carry their own meta CSP. Those stay closed to blob: whatever the page allows.
	it('keeps blob: out of the message body, sent preview and heatmap frames', () => {
		const heatmap = readFileSync(
			resolve(here, '..', 'components', 'dashboard', 'ClickHeatmap.vue'),
			'utf8'
		);
		// The component writes it inside a single-quoted string, so its quotes are escaped.
		const heatmapCsp = (
			/Content-Security-Policy" content="([^"]*)"/.exec(heatmap)?.[1] ?? ''
		).replaceAll("\\'", "'");
		const sentPreview = /content="([^"]*)"/.exec(
			sentPreviewSrcdoc('<html><head></head></html>')
		)?.[1];

		for (const policy of [POSTBOX_BODY_META_CSP, sentPreview ?? '', heatmapCsp]) {
			expect(policy).toContain("default-src 'none'");
			expect(policy).not.toContain('blob:');
		}
	});
});
