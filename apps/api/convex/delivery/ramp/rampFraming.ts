/**
 * WHAT THE FEATURE IS CALLED, AND WHAT ITS HEADLINE SAYS (plan D14).
 *
 * With a reference transport the ramp is "Sending Independence" and the number
 * that matters is the share of traffic leaving your own server. With no relay
 * there IS no share — s is 1 by definition — so a percentage headline would read
 * "100% independent" on day one of a warm-up, which is true and useless. The
 * feature is "Warm-up Autopilot" instead: same screens, same cells, same audit
 * trail, but the headline is CURRENT DAILY CAPACITY AND WHAT IS HOLDING IT BACK.
 *
 * THE CHOICE IS THE ACTUATOR'S, not a `hasRelay` boolean's. The actuator comes
 * out of the substitution table (`degradation.actuator`), so framing, gate
 * selection and ramp constants all move together off one fact.
 */

import type { RampActuator } from './degradation';

export type RampFramingId = 'warmup_autopilot' | 'sending_independence';

/**
 * What the headline is ABOUT. A closed union rather than a formatted string, so
 * a UI cannot render a percentage on the autopilot path by accident.
 */
export type RampHeadlineKind = 'capacity_and_blocker' | 'own_share_percentage';

export interface RampFraming {
	readonly id: RampFramingId;
	readonly featureName: string;
	readonly headlineKind: RampHeadlineKind;
	/** The one-line explanation under the headline. */
	readonly subtitle: string;
}

const FRAMINGS: Readonly<Record<RampActuator, RampFraming>> = {
	pace: {
		id: 'warmup_autopilot',
		featureName: 'Warm-up Autopilot',
		headlineKind: 'capacity_and_blocker',
		subtitle: 'How much mail this server can send today, and what decides that.',
	},
	share: {
		id: 'sending_independence',
		featureName: 'Sending Independence',
		headlineKind: 'own_share_percentage',
		subtitle: 'How much of your sending has moved to your own server.',
	},
};

export function resolveRampFraming(args: { readonly actuator: RampActuator }): RampFraming {
	return FRAMINGS[args.actuator];
}

export interface RampHeadlineInput {
	/** Emails per day the cell may currently send. */
	readonly dailyCapacity: number;
	/** What is holding that capacity back, or `null` when nothing is. */
	readonly blocker: string | null;
	/** Share of traffic on the own arm, as a fraction in [0, 1]. */
	readonly ownShare: number;
}

function formatWhole(value: number): string {
	if (!Number.isFinite(value) || value < 0) return '0';
	return String(Math.floor(value));
}

/**
 * The headline sentence for the framing.
 *
 * The autopilot branch NEVER states a percentage — not even a true one. That is
 * the point of the framing, and a fixture asserts the rendered string carries no
 * per-cent sign.
 */
export function rampHeadline(framing: RampFraming, input: RampHeadlineInput): string {
	if (framing.headlineKind === 'capacity_and_blocker') {
		const capacity = `${formatWhole(input.dailyCapacity)} emails a day`;
		return input.blocker === null ? capacity : `${capacity} — held by ${input.blocker}`;
	}
	const share = Number.isFinite(input.ownShare) ? Math.max(0, Math.min(1, input.ownShare)) : 0;
	return `${formatWhole(share * 100)}% of sending is on your own server`;
}
