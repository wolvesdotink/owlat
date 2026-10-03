// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Test tooling stays out of the production build (#1172).
 *
 * Nuxt registers every file it finds under `pages/`, `components/` and the
 * other app folders, and Nitro auto-imports everything under `server/utils/`.
 * A test helper in one of those trees became a route that bundled vitest, or
 * made Nitro trace vitest into the server output. The config keeps
 * `__tests__/` folders out of both scans; the source walk keeps test tooling
 * out of everything else those scans pick up. `scripts/check-web-build-test-code.ts`
 * checks the built output itself in CI.
 */

vi.mock('@tailwindcss/vite', () => ({ default: () => [] }));
vi.mock('../../scripts/uiLayerIcons', () => ({ uiLayerIconNames: () => [] }));

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiLayerRoot = resolve(webRoot, '..', '..', 'packages', 'ui');

/** The folders Nuxt (app, and the ui layer it extends) and Nitro scan as app code. */
const SCANNED_DIRS = [
	...['pages', 'components', 'composables', 'utils', 'middleware', 'plugins', 'layouts'].map(
		(dir) => join(webRoot, 'app', dir)
	),
	join(webRoot, 'server'),
	...['components', 'composables', 'utils'].map((dir) => join(uiLayerRoot, dir)),
];

const TEST_TOOLING =
	/\bfrom\s+['"](?:vitest|@vitest\/[^'"]+|@vue\/test-utils|@nuxt\/test-utils|@testing-library\/[^'"]+|happy-dom)['"]/;

function sourceFiles(dir: string): string[] {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
		return /\.(?:[cm]?[jt]sx?|vue)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)
			? [path]
			: [];
	});
}

async function loadConfig() {
	vi.resetModules();
	vi.stubGlobal('defineNuxtConfig', (config: unknown) => config);
	const { default: config } = await import('../../nuxt.config');
	return config;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('test code in the production build', () => {
	it('keeps __tests__ folders out of the Nuxt scans and the Nitro route scan', async () => {
		const config = await loadConfig();
		expect(config.ignore).toContain('**/__tests__/**');
	});

	it("keeps __tests__ folders out of Nitro's server/utils auto-imports", async () => {
		const config = await loadConfig();
		const imports = config.nitro?.imports;
		const fileFilter = imports ? imports.dirsScanOptions?.fileFilter : undefined;

		expect(fileFilter).toBeTypeOf('function');
		expect(fileFilter?.(join(webRoot, 'server/utils/__tests__/nitro.ts'))).toBe(false);
		expect(fileFilter?.('C:\\owlat\\apps\\web\\server\\utils\\__tests__\\nitro.ts')).toBe(false);
		expect(fileFilter?.(join(webRoot, 'server/utils/requireAdmin.ts'))).toBe(true);
	});

	it('imports no test tooling from a scanned file outside __tests__', () => {
		const offenders = SCANNED_DIRS.flatMap(sourceFiles)
			.filter((file) => TEST_TOOLING.test(readFileSync(file, 'utf8')))
			.map((file) => relative(webRoot, file));

		expect(offenders).toEqual([]);
	});
});
