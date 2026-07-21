import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ accessorReads: 0 }));

vi.mock('../../../plugins/agentStepModules.generated', () => ({
	BUNDLED_PLUGIN_AGENT_STEP_MODULES: [
		{
			kind: 'plugin.policy-pack.invalid',
			pluginId: 'policy-pack',
			module: Object.defineProperty({}, 'execute', {
				enumerable: true,
				get() {
					fixture.accessorReads += 1;
					return async () => ({ kind: 'continue' });
				},
			}),
		},
	],
}));

it('rejects an accessor-based generated module without invoking it', async () => {
	await expect(import('../index')).rejects.toThrow('Invalid hosted plugin agent step module');
	expect(fixture.accessorReads).toBe(0);
});
