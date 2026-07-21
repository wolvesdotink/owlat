import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ accessorReads: 0 }));

// A generated module whose `matches` is exposed via an accessor must be rejected
// at registry construction without ever invoking the accessor — the same
// hardening the agent-step module registry applies.
vi.mock('../../../plugins/automationTriggerModules.generated', () => ({
	BUNDLED_PLUGIN_AUTOMATION_TRIGGER_MODULES: [
		{
			kind: 'plugin.evil.trap',
			pluginId: 'evil',
			module: Object.defineProperty({ parseConfig: () => ({}) }, 'matches', {
				enumerable: true,
				get() {
					fixture.accessorReads += 1;
					return () => true;
				},
			}),
		},
	],
}));

it('rejects an accessor-based generated trigger module without invoking it', async () => {
	await expect(import('../pluginTriggers')).rejects.toThrow(
		'Invalid hosted plugin automation trigger module'
	);
	expect(fixture.accessorReads).toBe(0);
});
