import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `@owlat/plugin-kit` is the one package in the repo that gets published to npm.
 * `files` decides what lands in the tarball and `main`/`module`/`types` decide
 * what a consumer resolves — get either wrong and the published package either
 * ships TypeScript source it cannot compile or resolves to nothing at all.
 * `bun run build` is the only thing standing between this manifest and the
 * registry, so the manifest is pinned here rather than discovered by a consumer.
 */
describe('published package metadata', () => {
	it('publishes built JavaScript and declarations, not TypeScript source', () => {
		const pkg = JSON.parse(
			readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
		) as Record<string, unknown>;

		expect(pkg).toMatchObject({
			license: 'Apache-2.0',
			files: ['dist', 'README.md', 'LICENSE', 'NOTICE'],
			main: './dist/index.js',
			module: './dist/index.js',
			types: './dist/index.d.ts',
		});
	});
});
