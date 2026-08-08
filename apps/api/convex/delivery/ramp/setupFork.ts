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
 * THE FORK NAMES AN ACTUATOR; IT DOES NOT DECIDE ONE (D3). One controller, two
 * actuators, and the path an operator picks is the one they mean to run — but
 * the actuator the controller actually drives is re-resolved on EVERY tick by
 * `resolveRampDegradation`, from reference-arm traffic OBSERVED for that cell,
 * and never from this table.
 *
 * THE TWO READ DIFFERENT FACTS, ON PURPOSE. This table reads CONFIGURATION —
 * all that exists at the instant of enrolment, because a cell that has never
 * been cut has no relay traffic to observe — and the controller reads
 * MEASUREMENT. On a freshly-configured relay they disagree for one window: the
 * cell opens at its stream's share while the controller still runs the
 * standalone twin over it. They CONVERGE BY THEMSELVES and in the safe
 * direction, because the opening cut is what creates the traffic the
 * measurement then sees, and the standalone constants are the stricter ones. So
 * `actuator` here is the path's DESCRIPTION — the thing the copy beside it
 * promises — and nothing durable is stamped from it: `delivery/rampEnrollment.ts`
 * writes the ladder's first rung on BOTH paths for exactly that reason.
 *
 * `resolveSetupPath` IS CONSUMED: `delivery/rampEnrollment.ts` reads it to learn
 * which SHARE a newly-enrolled cell opens on. `resolveSetupFork` — the rendering
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
 * THE PATH A CELL IS ENROLLED ON, and therefore WHICH SHARE it opens at
 * (D3 x D14). The fork's preselection IS the answer: 'esp_relay' exactly when a
 * relay is configured, and no preselection means there is no second sender to
 * move traffic away from — the own-server path, by definition rather than by
 * default.
 *
 * NOT "which dial the ramp will drive": that is measured per tick, not chosen
 * here — see the header. This answers the one question enrolment has to settle
 * at the instant it writes, which is how much of the cell the own MTA opens on.
 *
 * Derived FROM the fork rather than beside it, so what a setup screen would
 * OFFER and what enrolment actually WRITES cannot describe the same
 * configuration differently.
 */
export function resolveSetupPath(args: { readonly hasRelayConfigured: boolean }): RampSetupPath {
	return RAMP_SETUP_PATHS_BY_ID[resolveSetupFork(args).preselected ?? 'own_server'];
}
