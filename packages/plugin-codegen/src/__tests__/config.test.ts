import { describe, expect, it } from 'vitest';
import { parsePluginsConfig } from '../config';

describe('plugins config parsing', () => {
	it('reads the literal package list without evaluating the module', () => {
		const source = `
      import type { PluginsConfig } from '@owlat/plugin-codegen';
      export default {
        bundledPluginPackages: ['@acme/mail-plugin', 'calendar-plugin'],
      } satisfies PluginsConfig;
    `;

		expect(parsePluginsConfig(source)).toEqual({
			bundledPluginPackages: ['@acme/mail-plugin', 'calendar-plugin'],
		});
	});

	it.each([
		[
			'executable statements',
			`console.info(process.env.SECRET); export default { bundledPluginPackages: [] };`,
		],
		['computed values', `export default { bundledPluginPackages: getPackages() };`],
		['array spreads', `export default { bundledPluginPackages: [...packages] };`],
		['extra config fields', `export default { bundledPluginPackages: [], unsafe: true };`],
		[
			'duplicate packages',
			`export default { bundledPluginPackages: ['mail-plugin', 'mail-plugin'] };`,
		],
		['package subpaths', `export default { bundledPluginPackages: ['mail-plugin/manifest'] };`],
		['path traversal', `export default { bundledPluginPackages: ['../mail-plugin'] };`],
		['uppercase package names', `export default { bundledPluginPackages: ['MailPlugin'] };`],
	] as const)('rejects %s', (_label, source) => {
		expect(() => parsePluginsConfig(source)).toThrow('Invalid plugins.config.ts');
	});

	it('bounds the number of installed packages', () => {
		const packages = Array.from({ length: 129 }, (_, index) => `'plugin-${index}'`).join(',');
		expect(() =>
			parsePluginsConfig(`export default { bundledPluginPackages: [${packages}] };`)
		).toThrow('at most 128');
	});
});
