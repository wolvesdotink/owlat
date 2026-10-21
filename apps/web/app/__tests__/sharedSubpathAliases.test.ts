// @vitest-environment node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config';

/**
 * The web suite does not resolve `@owlat/shared/*` through the package's
 * `exports`: vitest.config.ts aliases the specifiers onto the source tree. When
 * a new export broke the alias table's assumption (every subpath is
 * `src/<name>.ts` or `src/<name>/index.ts`), every web test that reached it
 * failed to transform, in CI only, because the package's own suite resolves
 * through `exports` and passed. This walks every export through the alias table
 * the way Vite does and expects the file the package itself names.
 */

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sharedRoot = resolve(webRoot, '..', '..', 'packages', 'shared');

// Vite's default `resolve.extensions`, tried in order after the bare path.
const VITE_EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];

type Alias = { find: string | RegExp; replacement: string };

function isFile(path: string): boolean {
	return existsSync(path) && statSync(path).isFile();
}

function viteFileResolve(path: string): string | null {
	if (isFile(path)) return path;
	for (const ext of VITE_EXTENSIONS) if (isFile(path + ext)) return path + ext;
	for (const ext of VITE_EXTENSIONS) {
		const index = resolve(path, `index${ext}`);
		if (isFile(index)) return index;
	}
	return null;
}

function applyAliases(specifier: string, aliases: readonly Alias[]): string | null {
	for (const { find, replacement } of aliases) {
		if (find instanceof RegExp) {
			if (find.test(specifier)) return specifier.replace(find, replacement);
		} else if (specifier === find || specifier.startsWith(`${find}/`)) {
			return replacement + specifier.slice(find.length);
		}
	}
	return null;
}

function exportTarget(entry: unknown): string {
	if (typeof entry === 'string') return entry;
	const conditions = entry as { import?: string; default?: string };
	return conditions.import ?? conditions.default ?? '';
}

const aliases = config.resolve?.alias as readonly Alias[];
const exportsMap = JSON.parse(readFileSync(resolve(sharedRoot, 'package.json'), 'utf8'))
	.exports as Record<string, unknown>;
const subpaths = Object.keys(exportsMap).filter(
	(key) => key.startsWith('./') && !key.endsWith('.json')
);

describe('@owlat/shared subpath aliases', () => {
	it('lists the subpath exports', () => {
		expect(subpaths).toContain('./caniemailData');
		expect(subpaths.length).toBeGreaterThan(50);
	});

	it.each(subpaths)('%s resolves to the file the package exports', (subpath) => {
		const aliased = applyAliases(`@owlat/shared/${subpath.slice(2)}`, aliases);
		expect(aliased).not.toBeNull();
		expect(viteFileResolve(aliased!)).toBe(resolve(sharedRoot, exportTarget(exportsMap[subpath])));
	});

	it('loads the Can I Email snapshot through the alias', async () => {
		const { default: snapshot } = await import('@owlat/shared/caniemailData');
		expect(Array.isArray(snapshot.data)).toBe(true);
		expect(typeof snapshot.nicenames).toBe('object');
	});
});
