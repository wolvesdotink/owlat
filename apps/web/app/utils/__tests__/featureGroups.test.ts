import { describe, expect, it } from 'vitest';
import {
	ALL_FEATURE_FLAG_KEYS,
	createFeatureFlagRegistry,
	FEATURE_FLAGS,
	FEATURE_PACKS,
} from '@owlat/shared/featureFlags';
import { groupFeatureFlags } from '../featureGroups';

describe('groupFeatureFlags', () => {
	const groups = groupFeatureFlags(FEATURE_FLAGS);
	const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));

	it('orders the three packs first and the switchless "more" group last', () => {
		expect(groups.map((g) => g.key)).toEqual(['emailClient', 'marketing', 'ai', 'more']);
		expect(byKey.more!.pack).toBeNull();
		expect(byKey.ai!.pack).toBe('ai');
	});

	it('lists every visible flag exactly once and hides hosted-only flags', () => {
		const listed = groups.flatMap((g) => g.flags.map((d) => d.key));
		expect(new Set(listed).size).toBe(listed.length);
		const visible = ALL_FEATURE_FLAG_KEYS.filter((k) => !FEATURE_FLAGS[k].hostedOnly);
		expect([...listed].sort()).toEqual([...visible].sort());
		expect(listed).not.toContain('billing.stripe');
	});

	it("leads each pack's list with the flags its switch flips, in pack order", () => {
		for (const pack of ['emailClient', 'marketing', 'ai'] as const) {
			const members = FEATURE_PACKS[pack].flags;
			const keys = byKey[pack]!.flags.map((d) => d.key);
			expect(keys.slice(0, members.length)).toEqual([...members]);
		}
	});

	it('customizes related non-member flags with their pack', () => {
		expect(byKey.ai!.flags.map((d) => d.key)).toEqual(
			expect.arrayContaining(['ai.decisionPlane', 'postbox.aiDraft'])
		);
		expect(byKey.emailClient!.flags.map((d) => d.key)).toContain('mail.external');
		expect(byKey.more!.flags.map((d) => d.key)).toEqual(
			expect.arrayContaining(['webhooks', 'scan.content', 'domains.verification'])
		);
	});

	it('files bundled plugin flags under "more"', () => {
		const registry = createFeatureFlagRegistry([
			{
				key: 'plugin.policy-pack',
				category: 'plugins',
				label: 'Policy pack',
				description: 'Bundled plugin.',
				default: false,
				pluginPackageName: '@example/policy-pack',
				requiredCapabilities: [],
			} as never,
		]);
		const more = groupFeatureFlags(registry).find((g) => g.key === 'more')!;
		expect(more.flags.map((d) => d.key)).toContain('plugin.policy-pack');
		expect(more.categories).toContain('plugins');
	});
});
