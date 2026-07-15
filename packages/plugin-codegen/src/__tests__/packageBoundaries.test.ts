import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	checkDirectPluginImports,
	findDirectPluginImports,
	isPluginBoundarySourceFile,
} from '../packageBoundaries';

const configuredPackages = ['@acme/mail-plugin'];
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('plugin package boundary lint', () => {
	it.each([
		[`import plugin from '@acme/mail-plugin';`, '@acme/mail-plugin'],
		[`export { plugin } from '@acme/mail-plugin/runtime';`, '@acme/mail-plugin/runtime'],
		[`const plugin = await import('@acme/mail-plugin');`, '@acme/mail-plugin'],
		['const plugin = await import(`@acme/mail-plugin`);', '@acme/mail-plugin'],
		[`const plugin = require('@acme/mail-plugin/server');`, '@acme/mail-plugin/server'],
		[`import plugin = require('@acme/mail-plugin/server');`, '@acme/mail-plugin/server'],
		[
			`import { createRequire } from 'node:module'; const loadPlugin = createRequire(import.meta.url); const plugin = loadPlugin('@acme/mail-plugin');`,
			'@acme/mail-plugin',
		],
		[
			`import moduleApi from 'node:module'; const plugin = moduleApi.createRequire(import.meta.url)('@acme/mail-plugin');`,
			'@acme/mail-plugin',
		],
		[`const plugin = Bun.require('@acme/mail-plugin');`, '@acme/mail-plugin'],
		[`const plugin = module.require('@acme/mail-plugin');`, '@acme/mail-plugin'],
		[
			`const plugin = require('node:module').createRequire(import.meta.url)('@acme/mail-plugin');`,
			'@acme/mail-plugin',
		],
		[
			`const moduleApi = require('module'); moduleApi.createRequire(__filename)('@acme/mail-plugin');`,
			'@acme/mail-plugin',
		],
		[
			`const { createRequire: makeRequire } = require('node:module'); makeRequire(__filename)('@acme/mail-plugin');`,
			'@acme/mail-plugin',
		],
		[`type Plugin = import('@acme/mail-plugin').Plugin;`, '@acme/mail-plugin'],
	] as const)('finds a configured package import in core source', (source, packageSpecifier) => {
		expect(findDirectPluginImports(source, 'apps/api/core.ts', configuredPackages)).toEqual([
			{ file: 'apps/api/core.ts', packageSpecifier },
		]);
	});

	it.each(['apps/api/core.mts', 'apps/api/core.cts'])('tracks %s modules', (file) => {
		expect(isPluginBoundarySourceFile(file)).toBe(true);
	});

	it('finds imports inside Vue script blocks', () => {
		const source = `<template><div /></template><script data-note=">" setup lang="ts">import plugin from '@acme/mail-plugin';</script>`;
		expect(findDirectPluginImports(source, 'apps/web/app.vue', configuredPackages)).toHaveLength(1);
	});

	it('finds package dependencies declared by a Vue script src attribute', () => {
		expect(
			findDirectPluginImports(
				'<template><div /></template><script src="@acme/mail-plugin"></script>',
				'apps/web/app.vue',
				configuredPackages
			)
		).toEqual([{ file: 'apps/web/app.vue', packageSpecifier: '@acme/mail-plugin' }]);
	});

	it('rejects malformed Vue sources with an attributed diagnostic', () => {
		expect(() =>
			findDirectPluginImports('<script setup lang="ts>', 'apps/web/app.vue', configuredPackages)
		).toThrow(expect.objectContaining({ code: 'source_invalid', details: ['apps/web/app.vue'] }));
	});

	it('ignores comments, ordinary strings, and similarly named packages', () => {
		const source = `
      // import '@acme/mail-plugin';
      const example = "import '@acme/mail-plugin'";
      import sibling from '@acme/mail-plugin-extra';
      void example;
      void sibling;
    `;
		expect(findDirectPluginImports(source, 'apps/api/core.ts', configuredPackages)).toEqual([]);
	});

	it('scans every repository source form without requiring Git metadata', async () => {
		const root = await createRepository({
			'apps/api/core.ts': `import '@acme/mail-plugin';`,
			'apps/api/core.tsx': `export { default } from '@acme/mail-plugin/runtime';`,
			'apps/api/core.mts': 'const plugin = await import(`@acme/mail-plugin`);',
			'apps/api/core.cts': `import plugin = require('@acme/mail-plugin');`,
			'apps/api/core.js': `import { createRequire } from 'node:module'; createRequire(import.meta.url)('@acme/mail-plugin');`,
			'apps/api/core.mjs': `Bun.require('@acme/mail-plugin');`,
			'apps/api/core.cjs': `require('@acme/mail-plugin/subpath');`,
			'apps/web/core.vue': `<script setup lang="ts">import type { Plugin } from '@acme/mail-plugin'; void (0 as unknown as Plugin);</script>`,
			'apps/web/near.jsx': `import sibling from '@acme/mail-plugin-extra'; void sibling;`,
		});

		await expect(checkDirectPluginImports(root, configuredPackages)).rejects.toMatchObject({
			code: 'direct_plugin_import',
			details: expect.arrayContaining([
				'apps/api/core.cts: imports @acme/mail-plugin',
				'apps/api/core.mts: imports @acme/mail-plugin',
				'apps/web/core.vue: imports @acme/mail-plugin',
			]),
		});
	});

	it('rejects package-import, npm-alias, and TypeScript-path aliases to plugins', async () => {
		const root = await createRepository(
			{
				'apps/api/import-map.ts': `import '#mail';`,
				'apps/api/npm-alias.ts': `import 'mail-alias';`,
				'apps/api/ts-path.ts': `import '@mail/runtime';`,
			},
			{
				imports: { '#mail': { node: '@acme/mail-plugin', default: './fallback.js' } },
				dependencies: { 'mail-alias': 'npm:@acme/mail-plugin@1.0.0' },
			}
		);
		await writeFile(
			join(root, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					paths: { '@mail/*': ['./node_modules/@acme/mail-plugin/*'] },
				},
			})
		);

		await expect(checkDirectPluginImports(root, configuredPackages)).rejects.toMatchObject({
			code: 'direct_plugin_import',
			details: [
				'apps/api/import-map.ts: imports #mail',
				'apps/api/npm-alias.ts: imports mail-alias',
				'apps/api/ts-path.ts: imports @mail/runtime',
			],
		});
	});

	it('rejects Vite object and array aliases to configured plugins', async () => {
		const root = await createRepository({
			'apps/api/object-alias.ts': `import 'mail-plugin-alias';`,
			'apps/api/array-alias.ts': `import 'mail-plugin-array';`,
			'apps/api/vite.config.ts': `export default { resolve: { alias: { 'mail-plugin-alias': '@acme/mail-plugin', }, }, test: { alias: [{ find: 'mail-plugin-array', replacement: '@acme/mail-plugin/runtime' }] } };`,
		});

		await expect(checkDirectPluginImports(root, configuredPackages)).rejects.toMatchObject({
			code: 'direct_plugin_import',
			details: [
				'apps/api/array-alias.ts: imports mail-plugin-array',
				'apps/api/object-alias.ts: imports mail-plugin-alias',
			],
		});
	});

	it('resolves exact Vite RegExp aliases without executing configuration', async () => {
		const root = await createRepository({
			'apps/api/regex-alias.ts': `import 'mail-plugin-alias';`,
			'apps/api/vite.config.ts': `export default { resolve: { alias: [{ find: /^mail-plugin-alias$/, replacement: '@acme/mail-plugin' }] } };`,
		});

		await expect(checkDirectPluginImports(root, configuredPackages)).rejects.toMatchObject({
			code: 'direct_plugin_import',
			details: ['apps/api/regex-alias.ts: imports mail-plugin-alias'],
		});
	});

	it('fails closed on non-exact static RegExp alias rules', async () => {
		const root = await createRepository({
			'apps/api/core.ts': `export const safe = true;`,
			'apps/api/vite.config.ts': `export default { resolve: { alias: [{ find: /^mail-(.+)$/, replacement: '@acme/mail-plugin' }] } };`,
		});

		await expect(checkDirectPluginImports(root, configuredPackages)).rejects.toMatchObject({
			code: 'repository_config_invalid',
			details: ['apps/api/vite.config.ts'],
		});
	});

	it('ignores unrelated nested untracked configs and attributes malformed tracked config', async () => {
		const root = await createRepository({
			'apps/api/core.ts': `export const safe = true;`,
			'apps/api/scratch/package.json': '{ invalid untracked json',
		});
		await expect(checkDirectPluginImports(root, configuredPackages)).resolves.toBeUndefined();

		await writeFile(join(root, 'apps/api/vite.config.ts'), 'export default { resolve: { alias:');
		await expect(checkDirectPluginImports(root, configuredPackages)).rejects.toMatchObject({
			code: 'repository_config_invalid',
			details: ['apps/api/vite.config.ts'],
		});
	});

	it('rejects oversized repository alias configuration before parsing', async () => {
		const root = await createRepository({
			'apps/api/core.ts': `export const safe = true;`,
			'apps/api/tsconfig.json': ' '.repeat(1024 * 1024 + 1),
		});
		await expect(checkDirectPluginImports(root, configuredPackages)).rejects.toMatchObject({
			code: 'repository_config_invalid',
			details: ['apps/api/tsconfig.json'],
		});
	});

	it('rejects oversized source before parsing it', async () => {
		const root = await createRepository({
			'apps/api/core.ts': ' '.repeat(2 * 1024 * 1024 + 1),
		});
		await expect(checkDirectPluginImports(root, configuredPackages)).rejects.toMatchObject({
			code: 'source_invalid',
			details: ['apps/api/core.ts'],
		});
	});

	it('reports Git inventory errors instead of scanning untracked filesystem state', async () => {
		const root = await createRepository({
			'apps/api/core.ts': `import '@acme/mail-plugin';`,
		});
		await mkdir(join(root, '.git'));

		await expect(checkDirectPluginImports(root, configuredPackages)).rejects.toMatchObject({
			code: 'repository_inventory_invalid',
		});
	});
});

async function createRepository(
	files: Readonly<Record<string, string>>,
	packageJson: Readonly<Record<string, unknown>> = {}
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-plugin-boundaries-'));
	temporaryRoots.push(root);
	await writeFile(join(root, 'package.json'), JSON.stringify(packageJson));
	for (const [path, source] of Object.entries(files)) {
		const absolutePath = join(root, path);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, source);
	}
	return root;
}
