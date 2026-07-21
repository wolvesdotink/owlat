import type { FeatureFlagDefinition } from '@owlat/shared/featureFlags';
import { describe, expect, it } from 'vitest';
import { validatePluginCapabilityApproval } from '../featureFlagRegistry';

const definition = {
	key: 'plugin.policy-pack',
	category: 'plugins',
	label: 'Policy Pack',
	description: 'Bundled plugin from @example/policy-pack.',
	default: false,
	requiredCapabilities: ['mail:read', 'send:gate'],
	pluginPackageName: '@example/policy-pack',
} satisfies FeatureFlagDefinition;

describe('plugin capability approval', () => {
	it('records an explicit decision for every manifest capability', () => {
		const grants = validatePluginCapabilityApproval(definition, ['send:gate', 'mail:read']);

		expect(grants).toEqual({ 'mail:read': true, 'send:gate': true });
		expect(Object.isFrozen(grants)).toBe(true);
	});

	it.each([
		['omitted approvals', undefined],
		['a missing approval', ['mail:read']],
		['duplicate approvals', ['mail:read', 'mail:read']],
		['an unknown approval', ['mail:read', 'contacts:write']],
	] as const)('rejects %s', (_label, approvals) => {
		expect(() => validatePluginCapabilityApproval(definition, approvals)).toThrow();
	});

	it('accepts an empty approval for a plugin that requests no capabilities', () => {
		const noCapabilities = {
			...definition,
			requiredCapabilities: [],
		} satisfies FeatureFlagDefinition;

		expect(validatePluginCapabilityApproval(noCapabilities, undefined)).toEqual({});
	});
});
