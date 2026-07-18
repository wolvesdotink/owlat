/**
 * The plugin's `crons` contribution: a low-frequency job that generates a
 * rotating deliverability tip through the host's BUDGETED LLM dispatch and logs
 * it for operators. It is deliberately tiny — its job in this reference is to
 * exercise the real contract:
 *   - LLM access is `services.llm` (attributed to this plugin, charged against
 *     its hard daily budget), never a raw model client;
 *   - the model's answer is UNTRUSTED text: it is clamped and only logged, never
 *     interpreted as an instruction;
 *   - cancellation is cooperative — the run checks `services.signal` and returns
 *     early if the host aborts it.
 */

import type { PluginCronModule, PluginCronServices } from '@owlat/plugin-kit';
import { buildDeliverabilityTipRequest } from './insights';

/** Largest slice of untrusted model output the cron will log. */
export const TIP_LOG_MAX_LENGTH = 400;

/** How the cron chooses which topic to ask about without a clock or RNG. */
export interface DeliverabilityTipCronConfig {
	/** Rotation index; the host may thread a run counter, defaulting to 0. */
	readonly rotation?: number;
}

function clampTip(text: string): string {
	// eslint-disable-next-line no-control-regex -- strip C0/C7F control chars from model output.
	const sanitized = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
	return [...sanitized].slice(0, TIP_LOG_MAX_LENGTH).join('');
}

export function createDeliverabilityTipCron(
	config: DeliverabilityTipCronConfig = {}
): PluginCronModule {
	const rotation = config.rotation ?? 0;
	return {
		async run(services: PluginCronServices): Promise<void> {
			if (services.signal.aborted) return;
			const request = buildDeliverabilityTipRequest(rotation);
			const result = await services.llm.generate(request);
			if (services.signal.aborted) return;
			const tip = clampTip(result.text);
			if (tip.length > 0) {
				services.logger.info('Deliverability tip refreshed', { tip });
			}
		},
	};
}

/** The bundled cron module the manifest points at. */
export const refreshSeedScoresCron: PluginCronModule = createDeliverabilityTipCron();
