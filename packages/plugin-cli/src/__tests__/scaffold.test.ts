import { join } from 'node:path';
import { parsePluginId } from '@owlat/plugin-kit';
import type { PluginPackageName } from '@owlat/plugin-host';
import { describe, expect, it } from 'vitest';
import { buildScaffold, toCamelCase } from '../scaffold';

const root = '/workspace';
const targetDir = join(root, 'examples', 'plugins', 'my-plugin');
const id = parsePluginId('my-plugin');
const packageName = '@owlat/plugin-my-plugin' as PluginPackageName;

describe('toCamelCase', () => {
	it('converts a kebab-case id to lowerCamelCase', () => {
		expect(toCamelCase('deliverability-lab')).toBe('deliverabilityLab');
		expect(toCamelCase('a-b-c')).toBe('aBC');
		expect(toCamelCase('single')).toBe('single');
	});
});

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
	});

	it('generates a manifest that declares the requested id and camelCased export', () => {
		const manifest = buildScaffold(root, targetDir, id, packageName).get('src/manifest.ts') ?? '';
		expect(manifest).toContain("id: 'my-plugin'");
		expect(manifest).toContain('export const myPluginPlugin = definePlugin(');
		expect(buildScaffold(root, targetDir, id, packageName).get('src/index.ts')).toContain(
			"export { myPluginPlugin } from './manifest';"
		);
	});
});
