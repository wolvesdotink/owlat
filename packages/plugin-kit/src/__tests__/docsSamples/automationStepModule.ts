// #region automation-step-module
import type {
	PluginAutomationStepInput,
	PluginAutomationStepModule,
	PluginAutomationStepResult,
} from '@owlat/plugin-kit';

interface NotifyConfig {
	readonly channel: string;
}

export const automationStep: PluginAutomationStepModule<NotifyConfig> = {
	parseConfig(raw: unknown): NotifyConfig {
		const channel = (raw as { channel?: unknown } | null)?.channel;
		if (typeof channel !== 'string' || channel.length === 0) {
			throw new TypeError('config.channel is required');
		}
		return { channel };
	},

	async execute(
		input: PluginAutomationStepInput,
		config: NotifyConfig
	): Promise<PluginAutomationStepResult> {
		if (!input.contactEmail.includes('@')) {
			return { kind: 'failed', reason: 'contact has no address' };
		}
		await Promise.resolve(config.channel);
		return { kind: 'completed' };
	},
};
// #endregion automation-step-module
