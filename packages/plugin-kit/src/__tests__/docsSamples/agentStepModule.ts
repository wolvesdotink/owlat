// #region agent-step-module
import type {
	PluginAgentStepInput,
	PluginAgentStepModule,
	PluginAgentStepResult,
} from '@owlat/plugin-kit';

export const agentStep: PluginAgentStepModule = {
	async execute(input: PluginAgentStepInput): Promise<PluginAgentStepResult> {
		if (input.subject.toLowerCase().startsWith('[auto-reply]')) {
			// Restrict-only: a step may request a DECLARED caution edge, but never
			// choose the next step, approve, or send.
			return { kind: 'caution', to: 'archived', reason: 'vendor auto-reply' };
		}
		return { kind: 'continue' };
	},
};
// #endregion agent-step-module
