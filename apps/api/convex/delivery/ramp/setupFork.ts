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
 * `resolveSetupPath` IS CONSUMED: `delivery/rampEnrollment.ts` reads it to learn
 * which dial a newly-enrolled cell starts on. `resolveSetupFork` — the rendering
 * shape, with both paths and the preselection — is still staged for a setup
 * screen that does not exist yet; the enrolment mutation is the door until it
 * does. Both answers come off ONE table so the screen, when it arrives, cannot
 * offer a path enrolment would not write, or add a `recommended` badge of its own.
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

/**
 * KEYED, so a path can be looked up TOTALLY. Enrolment reads a path to learn
 * which dial it is starting; a `find` over the list would hand it an
 * `undefined` the write path would then have to invent a default for, and that
 * default would be a second, silent copy of the fork.
 */
const RAMP_SETUP_PATHS_BY_ID: Readonly<Record<RampSetupPathId, RampSetupPath>> = {
	own_server: {
		id: 'own_server',
		title: 'Start on my own server',
		summary:
			'Send everything from your own IP from day one, and let Warm-up Autopilot grow the daily volume as the evidence allows.',
		tradeOff:
			'Slower to full volume, and placement is measured from your own seed mailboxes rather than against a second sender.',
		actuator: 'pace',
		isRecommended: false,
	},
	esp_relay: {
		id: 'esp_relay',
		title: 'Ramp up safely using an ESP I already pay for',
		summary:
			'Keep sending through your existing provider and move traffic to your own IP a measured share at a time.',
		tradeOff:
			'You keep paying the provider while the ramp runs, and every recipient is assigned to one of the two arms.',
		actuator: 'share',
		isRecommended: false,
	},
};

/** ORDER IS PART OF THE OFFER: the two paths are presented in this order. */
export const RAMP_SETUP_PATHS: readonly RampSetupPath[] = [
	RAMP_SETUP_PATHS_BY_ID.own_server,
	RAMP_SETUP_PATHS_BY_ID.esp_relay,
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

/**
 * THE PATH A CELL IS ENROLLED ON, and therefore WHICH DIAL the ramp will drive
 * (D3 x D14). The fork's preselection IS the answer: 'esp_relay' exactly when a
 * relay is configured, and no preselection means there is no second sender to
 * move traffic away from — the own-server path, by definition rather than by
 * default.
 *
 * Derived FROM the fork rather than beside it, so what a setup screen would
 * OFFER and what enrolment actually WRITES cannot describe the same
 * configuration differently.
 */
export function resolveSetupPath(args: { readonly hasRelayConfigured: boolean }): RampSetupPath {
	return RAMP_SETUP_PATHS_BY_ID[resolveSetupFork(args).preselected ?? 'own_server'];
}
