import { describe, expect, it, vi } from 'vitest';

vi.mock('../../plugins/automationConditionCatalog.generated', () => ({
	BUNDLED_PLUGIN_AUTOMATION_CONDITION_CATALOG: [
		{
			kind: 'plugin.scoring.high_intent',
			pluginId: 'scoring',
			localId: 'high-intent',
			label: 'High intent',
			description: 'Contact scores above the intent threshold',
			icon: 'gauge',
			requiredEnvVars: [],
			requiredCapability: 'automation:condition',
		},
	],
}));

const catalog = await import('../catalog');

describe('automation condition catalog', () => {
	it('pins the built-in condition kinds and their order', () => {
		expect(catalog.CORE_CONDITION_KINDS).toEqual([
			'contact_property',
			'email_activity',
			'topic_membership',
		]);
	});

	it('classifies core and plugin kinds', () => {
		expect(catalog.isCoreConditionKind('contact_property')).toBe(true);
		expect(catalog.isCoreConditionKind('plugin.scoring.high_intent')).toBe(false);
		expect(catalog.isPluginConditionKind('plugin.scoring.high_intent')).toBe(true);
		expect(catalog.isPluginConditionKind('plugin.scoring.ghost')).toBe(false);
	});

	it('exposes the owning plugin id and gating metadata for a plugin kind', () => {
		const entry = catalog.pluginConditionCatalogEntry('plugin.scoring.high_intent');
		expect(entry?.pluginId).toBe('scoring');
		expect(entry?.requiredCapability).toBe('automation:condition');
	});
});
