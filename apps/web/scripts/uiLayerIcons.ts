/**
 * The icon names the packages/ui layer renders, read at build time for
 * `icon.clientBundle.icons` in nuxt.config.ts.
 *
 * @nuxt/icon's scan globs are resolved against the Nuxt rootDir (apps/web), so
 * the layer is outside them and its icons never reach the client bundle — which
 * is what makes them render in the offline desktop app. A glob that climbs out
 * of the rootDir is not the fix: tinyglobby re-roots every pattern on their
 * common ancestor, and the app's own scan then matches almost nothing.
 *
 * `scripts/check-icon-names.sh` covers this directory too, so a name that lands
 * here unresolvable, or in a file type this reader skips, fails the lint.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the app's icon scan (nuxt.config.ts `icon.clientBundle.scan`) skips:
 * @nuxt/icon's own defaults, which setting the option replaces, plus test
 * files. Every name the scan finds is bundled into the entry chunk, and a name
 * that only a test quotes renders nothing. The defaults' `tests` does not cover
 * this app's `__tests__` directories or a `*.test.ts` beside its module.
 */
export const ICON_SCAN_EXCLUDE = [
	'node_modules',
	'dist',
	'build',
	'coverage',
	'test',
	'tests',
	'.*',
	'**/__tests__/**',
	'**/*.test.*',
	'**/*.spec.*',
];

const TEST_FILE = /\.(?:test|spec)\.[^.]+$/;

/** Every `lucide:*` name under packages/ui, sorted and de-duplicated. Tests are skipped. */
export function uiLayerIconNames(
	root = fileURLToPath(new URL('../../../packages/ui', import.meta.url))
): string[] {
	const names = new Set<string>();
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
			if (entry.name === '__tests__' || TEST_FILE.test(entry.name)) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else if (/\.(?:vue|ts)$/.test(entry.name)) {
				for (const match of readFileSync(path, 'utf8').matchAll(/\blucide:[a-z0-9-]+/g)) {
					names.add(match[0]);
				}
			}
		}
	};
	walk(root);
	return [...names].sort();
}
