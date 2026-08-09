import { join } from 'node:path';
import { parsePluginId } from '@owlat/plugin-kit';
import type { PluginPackageName } from '@owlat/plugin-host';
import { describe, expect, it } from 'vitest';
import { buildScaffold } from '../scaffold';

const root = '/workspace';
const targetDir = join(root, 'examples', 'plugins', 'my-plugin');
const id = parsePluginId('my-plugin');
const packageName = '@owlat/plugin-my-plugin' as PluginPackageName;

describe('buildScaffold', () => {
	it('is deterministic for identical inputs', () => {
		const first = buildScaffold(root, targetDir, id, packageName);
		const second = buildScaffold(root, targetDir, id, packageName);
		expect([...first.entries()]).toEqual([...second.entries()]);
	});

	it('emits a full package skeleton', () => {
		const files = buildScaffold(root, targetDir, id, packageName);
		expect([...files.keys()].sort()).toEqual([
			'README.md',
			'package.json',
			'src/__tests__/manifest.test.ts',
			'src/index.ts',
			'src/manifest.ts',
			'tsconfig.json',
			'vitest.config.ts',
		]);
	});

	it('wires config paths relative to the target directory depth', () => {
		const packageJson = JSON.parse(
			buildScaffold(root, targetDir, id, packageName).get('package.json') ?? '{}'
		);
		expect(packageJson.name).toBe(packageName);
		expect(packageJson.dependencies['@owlat/plugin-kit']).toBe('workspace:*');
		expect(packageJson.scripts.lint).toBe('oxlint --config ../../../oxlintrc.json src');

		const tsconfig = JSON.parse(
			buildScaffold(root, targetDir, id, packageName).get('tsconfig.json') ?? '{}'
		);
		expect(tsconfig.extends).toBe('../../../tsconfig.base.json');
		expect(tsconfig.compilerOptions.paths).toMatchObject({
			'@owlat/plugin-kit': ['../../../packages/plugin-kit/src/index.ts'],
			'@owlat/provider-kit': ['../../../packages/provider-kit/src/index.ts'],
		});
		const vitest = buildScaffold(root, targetDir, id, packageName).get('vitest.config.ts') ?? '';
		expect(vitest).toContain("'@owlat/plugin-kit': resolve(");
		expect(vitest).toContain("'@owlat/provider-kit': resolve(");
	});

	it('generates a manifest that declares the requested id and camelCased export', () => {
		const manifest = buildScaffold(root, targetDir, id, packageName).get('src/manifest.ts') ?? '';
		expect(manifest).toContain("id: 'my-plugin'");
		expect(manifest).toContain('export const myPluginPlugin = definePlugin(');
		expect(buildScaffold(root, targetDir, id, packageName).get('src/index.ts')).toContain(
			"export { myPluginPlugin } from './manifest';"
		);
	});

	/**
	 * AND AS THE PACKAGE'S DEFAULT EXPORT, which is the one codegen reads: the
	 * generated composition writes `import bundledPluginManifest0 from '<package>'`,
	 * so a scaffolded package that only exported its manifest by name would compose
	 * into `{ packageName, manifest: undefined }` and fail at the host's validation
	 * rather than at anything this generator can see.
	 */
	it('default-exports the manifest the generated composition imports', () => {
		const files = buildScaffold(root, targetDir, id, packageName);
		expect(files.get('src/manifest.ts')).toContain('export default myPluginPlugin;');
		expect(files.get('src/index.ts')).toContain("export { default } from './manifest';");
	});
});
