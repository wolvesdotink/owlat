/**
 * THE SETUP FORK (plan D14) — two paths, offered as EQUAL choices.
 *
 * "Start on my own server" and "Ramp up safely using an ESP I already pay for"
 * are both first-class ways to run this deployment. The trade-off is stated
 * plainly on each; NEITHER is labelled recommended, and the ESP path is
 * pre-selected only when a relay is already configured — that is a convenience
 * for a deployment that has already made the choice, not a recommendation.
 *
 * `isRecommended: false` is a FIELD on both paths rather than an absence, so the
 * invariant is asserted by a fixture instead of resting on nobody adding a
 * badge later.
 *
 * THE FORK IS THE ACTUATOR CHOICE (D3), and it says so: one controller, two
 * actuators, and the path an operator picks is which one it drives.
 *
 * CONSUMED BY the delivery screens piece (P4-9) — this module is the model the
 * setup screen renders. It is staged here, beside the actuator it names, so the
 * screen cannot invent a third path or a `recommended` badge of its own.
 */

import type { RampActuator } from './degradation';

export type RampSetupPathId = 'own_server' | 'esp_relay';

export interface RampSetupPath {
	readonly id: RampSetupPathId;
	readonly title: string;
	/** What this path does, in one sentence. */
	readonly summary: string;
	/** What it costs, stated plainly rather than implied by ordering. */
	readonly tradeOff: string;
	readonly actuator: RampActuator;
	/** ALWAYS false on BOTH paths. Neither choice is the recommended one. */
	readonly isRecommended: false;
}

export const RAMP_SETUP_PATHS: readonly RampSetupPath[] = [
	{
		id: 'own_server',
		title: 'Start on my own server',
		summary:
			'Send everything from your own IP from day one, and let Warm-up Autopilot grow the daily volume as the evidence allows.',
		tradeOff:
			'Slower to full volume, and placement is measured from your own seed mailboxes rather than against a second sender.',
		actuator: 'pace',
		isRecommended: false,
	},
	{
		id: 'esp_relay',
		title: 'Ramp up safely using an ESP I already pay for',
		summary:
			'Keep sending through your existing provider and move traffic to your own IP a measured share at a time.',
		tradeOff:
			'You keep paying the provider while the ramp runs, and every recipient is assigned to one of the two arms.',
		actuator: 'share',
		isRecommended: false,
	},
];

export interface RampSetupForkChoice {
	readonly paths: readonly RampSetupPath[];
	/**
	 * Which path the form opens on. `null` — nothing pre-selected — unless a
	 * relay is already configured, in which case the ESP path is pre-filled
	 * because the deployment has already connected the thing it needs.
	 */
	readonly preselected: RampSetupPathId | null;
}

export function resolveSetupFork(args: {
	readonly hasRelayConfigured: boolean;
}): RampSetupForkChoice {
	return {
		paths: RAMP_SETUP_PATHS,
		preselected: args.hasRelayConfigured ? 'esp_relay' : null,
	};
}
