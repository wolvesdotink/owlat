import { describe, expect, it } from 'vitest';
import type { FeatureFlagState } from '@owlat/shared/featureFlags';
import { resolveStoredFeatureFlags } from '../featureFlags';

describe('resolveStoredFeatureFlags', () => {
	it('keeps registered core overrides while dropping stale plugin keys', () => {
		const stored = {
			inbox: true,
			'plugin.removed': true,
			'plugin.Bad_Id': true,
		} as FeatureFlagState;

		const resolved = resolveStoredFeatureFlags(stored);

		expect(resolved.inbox).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(resolved, 'plugin.removed')).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(resolved, 'plugin.Bad_Id')).toBe(false);
	});

	it.each(['toString', 'constructor', '__proto__'])(
		'does not resolve inherited object key %s',
		(key) => {
			const resolved = resolveStoredFeatureFlags({ [key]: true } as FeatureFlagState);
			expect(Object.prototype.hasOwnProperty.call(resolved, key)).toBe(false);
		}
	);
});
