import { composeBundledPlugins, getBundledPluginFeatureFlagDefinitions } from '../index';
import { describe, expect, it } from 'vitest';

describe('bundled plugin feature-flag definitions', () => {
	it('derives immutable definitions from the validated composition', () => {
		const composition = composeBundledPlugins([
			{
				packageName: '@example/deliverability-lab',
				manifest: {
					id: 'deliverability-lab',
					version: '1.0.0',
					capabilities: ['campaigns:read', 'send:gate'],
					flag: { default: false, requiredEnvVars: ['SEEDBOX_API_KEY'] },
				},
			},
		]);

		const definitions = getBundledPluginFeatureFlagDefinitions(composition);

		expect(definitions).toEqual([
			{
				key: 'plugin.deliverability-lab',
				category: 'plugins',
				label: 'Deliverability Lab',
				description: 'Bundled plugin from @example/deliverability-lab.',
				default: false,
				requiredEnvVars: ['SEEDBOX_API_KEY'],
				requiredCapabilities: ['campaigns:read', 'send:gate'],
				pluginPackageName: '@example/deliverability-lab',
			},
		]);
		expect(Object.isFrozen(definitions)).toBe(true);
		expect(Object.isFrozen(definitions[0])).toBe(true);
		expect(Object.isFrozen(definitions[0]?.requiredEnvVars)).toBe(true);
		expect(Object.isFrozen(definitions[0]?.requiredCapabilities)).toBe(true);
	});

	it('omits plugins that declare no runtime flag', () => {
		const composition = composeBundledPlugins([
			{
				packageName: '@example/always-composed',
				manifest: { id: 'always-composed', version: '1.0.0', capabilities: [] },
			},
		]);

		expect(getBundledPluginFeatureFlagDefinitions(composition)).toEqual([]);
	});
});
