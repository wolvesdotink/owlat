import { describe, expect, it, vi } from 'vitest';

// Inject one synthetic bundled plugin step so the same suite pins the built-in
// membership AND proves the kind space opens to a namespaced plugin kind.
vi.mock('../../../plugins/automationStepCatalog.generated', () => ({
	BUNDLED_PLUGIN_AUTOMATION_STEP_CATALOG: [
		{
			kind: 'plugin.deliverability.notify',
			pluginId: 'deliverability',
			localId: 'notify',
			label: 'Notify',
			description: 'Send a notification',
			icon: 'bell',
			requiredEnvVars: ['NOTIFY_TOKEN'],
			requiredCapability: 'automation:step',
		},
	],
}));

const catalog = await import('../catalog');

describe('automation step catalog', () => {
	it('pins the built-in step kinds and their order', () => {
		expect(catalog.CORE_STEP_KINDS).toEqual(['email', 'delay', 'condition']);
	});

	it('appends composed plugin kinds after the core kinds', () => {
		expect(catalog.STEP_KINDS).toEqual([
			'email',
			'delay',
			'condition',
			'plugin.deliverability.notify',
		]);
	});

	it('classifies core and plugin kinds without cross-contamination', () => {
		expect(catalog.isCoreStepKind('email')).toBe(true);
		expect(catalog.isCoreStepKind('plugin.deliverability.notify')).toBe(false);
		expect(catalog.isPluginStepKind('plugin.deliverability.notify')).toBe(true);
		expect(catalog.isPluginStepKind('email')).toBe(false);
		// A plugin-shaped kind absent from the catalog is not a recognised plugin kind.
		expect(catalog.isPluginStepKind('plugin.deliverability.ghost')).toBe(false);
	});

	it('exposes the owning plugin id and gating metadata for a plugin kind', () => {
		expect(catalog.stepPluginId('plugin.deliverability.notify')).toBe('deliverability');
		expect(catalog.stepPluginId('email')).toBeUndefined();
		const entry = catalog.pluginStepCatalogEntry('plugin.deliverability.notify');
		expect(entry?.requiredEnvVars).toEqual(['NOTIFY_TOKEN']);
		expect(entry?.requiredCapability).toBe('automation:step');
	});
});
