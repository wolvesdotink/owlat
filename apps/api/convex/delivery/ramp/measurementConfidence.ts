/**
 * PER-CELL MEASUREMENT CONFIDENCE (plan D14) — say the quiet part, offer a fix.
 *
 * Every cell exposes what its measurement is worth AND a concrete affordance
 * naming the specific integration that would improve it and what it would buy.
 * Both come out of the substitution table, so the sentence an operator reads is
 * the same fact the controller acted on (plan D5: the controller and the
 * dashboard may never disagree about a number).
 *
 * TONE IS A FIELD, NOT A CONVENTION. Absence of a third-party account is a
 * SUPPORTED CONFIGURATION (D2), so this surface is `info` and can be nothing
 * else: no error state, no unresolvable warning, no "setup incomplete" nag. The
 * type makes the other tones unrepresentable and a fixture asserts it.
 */

import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import { weakestConfidence } from './gateGrades';
import type { RampGateConfidence } from './gateTypes';
import type { RampDegradation, RampImprovementOffer } from './degradation';

/** The only tone this surface has. An offer is not a warning. */
export const RAMP_CONFIDENCE_TONE = 'info';

export type RampConfidenceTone = typeof RAMP_CONFIDENCE_TONE;

const CONFIDENCE_HEADLINE: Readonly<Record<RampGateConfidence, string>> = {
	high: 'Measurement confidence: high',
	medium: 'Measurement confidence: medium',
	low: 'Measurement confidence: low',
};

export interface RampCellConfidence {
	readonly provider: DestinationProviderKey;
	readonly level: RampGateConfidence;
	/** "Measurement confidence: low" — the level as one short sentence. */
	readonly headline: string;
	/** Why it is what it is: one note per absent integration governing the cell. */
	readonly notes: readonly string[];
	/** "Connect X — it buys Y". Empty when there is nothing left to offer. */
	readonly improvements: readonly RampImprovementOffer[];
	readonly tone: RampConfidenceTone;
	/** ALWAYS false — confidence never gates a send or a screen (D2). */
	readonly isBlocking: false;
}

/**
 * The cell's confidence: the WEAKEST of what the gates actually measured and
 * what the deployment's integrations allow it to measure at all.
 *
 * Both halves matter and neither subsumes the other. A cell whose gates all
 * returned high-confidence direct measurements is still only as good as the
 * signals it has — a bounce rate says nothing about the spam folder — and a
 * fully-equipped deployment whose engagement gate fell back to the trailing
 * baseline this window is not measuring at high confidence either.
 */
export function rampCellConfidence(args: {
	readonly degradation: RampDegradation;
	/** What the gates that DECIDED were worth this window. */
	readonly evaluated: RampGateConfidence;
}): RampCellConfidence {
	const { degradation, evaluated } = args;
	const level = weakestConfidence([evaluated, degradation.confidence]);
	return {
		provider: degradation.provider,
		level,
		headline: CONFIDENCE_HEADLINE[level],
		notes: degradation.notes,
		improvements: degradation.improvements,
		tone: RAMP_CONFIDENCE_TONE,
		isBlocking: false,
	};
}
