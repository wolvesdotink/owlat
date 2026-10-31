// #region cron-module
import type { PluginCronModule, PluginCronServices } from '@owlat/plugin-kit';

export const cron: PluginCronModule = {
	async run(services: PluginCronServices): Promise<void> {
		// Cancellation is cooperative: the host aborts `signal` at the declared
		// timeout and stops waiting either way.
		if (services.signal.aborted) return;
		const summary = await services.llm.generate({
			tier: 'fast',
			prompt: 'Summarise this week of deliverability tips in one sentence.',
		});
		services.logger.info('refreshed preflight rules', { length: summary.text.length });
	},
};
// #endregion cron-module
