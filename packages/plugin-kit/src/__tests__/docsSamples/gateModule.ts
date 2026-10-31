// #region gate-module
import type {
	PluginAutonomyGateInput,
	PluginAutonomyGateModule,
	PluginAutonomyGateResult,
	PluginAutonomyGateServices,
} from '@owlat/plugin-kit';

/** A gate may object or stand aside. There is deliberately no "approve" result. */
export const gate: PluginAutonomyGateModule = {
	async evaluate(
		input: PluginAutonomyGateInput,
		services: PluginAutonomyGateServices
	): Promise<PluginAutonomyGateResult> {
		if (services.signal.aborted) return { outcome: 'objection', reason: 'preflight cancelled' };
		if (input.draftBody.includes('http://')) {
			return { outcome: 'objection', reason: 'draft contains a plaintext HTTP link' };
		}
		return { outcome: 'no-objection' };
	},
};
// #endregion gate-module
