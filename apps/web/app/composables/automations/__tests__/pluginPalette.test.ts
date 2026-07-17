import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../api/convex/plugins/automationTriggerCatalog.generated', () => ({
	BUNDLED_PLUGIN_AUTOMATION_TRIGGER_CATALOG: [
		{
			kind: 'plugin.crm.deal_won',
			label: 'Deal won',
			description: 'A deal closed',
			icon: 'trophy',
		},
	],
}));
vi.mock('../../../../../api/convex/plugins/automationStepCatalog.generated', () => ({
	BUNDLED_PLUGIN_AUTOMATION_STEP_CATALOG: [
		{ kind: 'plugin.crm.notify', label: 'Notify', description: 'Send a note', icon: 'bell' },
	],
}));
vi.mock('../../../../../api/convex/plugins/automationConditionCatalog.generated', () => ({
	BUNDLED_PLUGIN_AUTOMATION_CONDITION_CATALOG: [
		{ kind: 'plugin.crm.vip', label: 'Is VIP', description: 'Contact is a VIP', icon: 'star' },
	],
}));

const { useAutomationPluginPalette } = await import('../pluginPalette');

describe('useAutomationPluginPalette', () => {
	it('connects the generated editor metadata for every automation registry', () => {
		const palette = useAutomationPluginPalette();
		expect(palette.triggers).toEqual([
			{
				kind: 'plugin.crm.deal_won',
				label: 'Deal won',
				description: 'A deal closed',
				icon: 'trophy',
			},
		]);
		expect(palette.steps).toEqual([
			{ kind: 'plugin.crm.notify', label: 'Notify', description: 'Send a note', icon: 'bell' },
		]);
		expect(palette.conditions).toEqual([
			{ kind: 'plugin.crm.vip', label: 'Is VIP', description: 'Contact is a VIP', icon: 'star' },
		]);
	});
});
