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

/** Every `lucide:*` name under packages/ui, sorted and de-duplicated. */
export function uiLayerIconNames(): string[] {
	const root = fileURLToPath(new URL('../../../packages/ui', import.meta.url));
	const names = new Set<string>();
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
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
