import { describe, expect, it, vi } from 'vitest';
import { runWithPluginFeatureFlag } from '../index';

describe('plugin feature-flag enforcement', () => {
	it('runs statically composed code only for an explicit true result', async () => {
		const operation = vi.fn(() => 'ran');

		await expect(
			runWithPluginFeatureFlag({ isEnabled: async () => true }, 'policy-pack', operation)
		).resolves.toBe('ran');
		expect(operation).toHaveBeenCalledOnce();
	});

	it.each([
		['false', false],
		['undefined', undefined],
		['a truthy non-boolean', 'true'],
	] as const)('fails closed for %s', async (_label, enabled) => {
		const operation = vi.fn();

		await expect(
			runWithPluginFeatureFlag({ isEnabled: () => enabled as boolean }, 'policy-pack', operation)
		).rejects.toMatchObject({
			code: 'plugin_disabled',
			pluginId: 'policy-pack',
		});
		expect(operation).not.toHaveBeenCalled();
	});

	it('denies execution when flag resolution fails', async () => {
		const operation = vi.fn();

		await expect(
			runWithPluginFeatureFlag(
				{
					isEnabled() {
						throw new Error('database unavailable');
					},
				},
				'policy-pack',
				operation
			)
		).rejects.toMatchObject({ code: 'feature_check_failed' });
		expect(operation).not.toHaveBeenCalled();
	});
});
