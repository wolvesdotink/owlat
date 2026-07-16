import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../plugins/automationTriggerCatalog.generated', () => ({
	BUNDLED_PLUGIN_AUTOMATION_TRIGGER_CATALOG: [
		{
			kind: 'plugin.crm-sync.deal_won',
			pluginId: 'crm-sync',
			localId: 'deal-won',
			label: 'Deal won',
			description: 'A CRM deal was marked won',
			icon: 'trophy',
			requiredEnvVars: ['CRM_TOKEN'],
			requiredCapability: 'automation:trigger',
		},
	],
}));

const catalog = await import('../catalog');

describe('automation trigger catalog', () => {
	it('pins the built-in trigger kinds and their order', () => {
		expect(catalog.CORE_TRIGGER_KINDS).toEqual([
			'contact_created',
			'contact_updated',
			'event_received',
			'topic_subscribed',
		]);
	});

	it('appends composed plugin kinds after the core kinds', () => {
		expect(catalog.TRIGGER_KINDS).toEqual([
			'contact_created',
			'contact_updated',
			'event_received',
			'topic_subscribed',
			'plugin.crm-sync.deal_won',
		]);
	});

	it('classifies core and plugin kinds', () => {
		expect(catalog.isCoreTriggerKind('contact_created')).toBe(true);
		expect(catalog.isCoreTriggerKind('plugin.crm-sync.deal_won')).toBe(false);
		expect(catalog.isPluginTriggerKind('plugin.crm-sync.deal_won')).toBe(true);
		expect(catalog.isPluginTriggerKind('plugin.crm-sync.ghost')).toBe(false);
	});

	it('exposes plugin ownership and editor metadata', () => {
		expect(catalog.triggerPluginId('plugin.crm-sync.deal_won')).toBe('crm-sync');
		expect(catalog.PLUGIN_TRIGGER_EDITOR_CATALOG).toEqual([
			{
				kind: 'plugin.crm-sync.deal_won',
				label: 'Deal won',
				description: 'A CRM deal was marked won',
				icon: 'trophy',
			},
		]);
	});
});
