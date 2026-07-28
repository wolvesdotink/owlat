/**
 * Ramp controller — HOW MUCH A VERDICT IS WORTH (plan D14).
 *
 * Four grades, declared once and shared by every gate implementation, so
 * "measurement confidence" means the same thing on the reference-arm evaluator,
 * on the standalone one and on the dashboard that renders both. A grade is data
 * on the result (`RampGateGrade`), never a caller convention — see
 * `mayJustifyIncrease` in `gateTypes.ts` for why that distinction is the whole
 * defence against ramping on a weak signal.
 *
 * `weakestConfidence` lives here too, and for the same reason: how much a set of
 * verdicts is worth is the same subject as how much one of them is worth, and
 * `gateTypes.ts` says on its first line that it is types only.
 */

import { SEED_GATE_CONFIDENCE } from '@owlat/shared/seedPlacement';
import type { RampGateConfidence, RampGateGrade } from './gateTypes';

/**
 * Bounces, 4xx text and complaint feedback are measured on OUR OWN WIRE — they
 * never depended on a third party and do not become less trustworthy when one is
 * absent (plan D2). Their `pass` is full evidence for an increase.
 */
export const DIRECT_MEASUREMENT: RampGateGrade = { confidence: 'high', mayJustifyIncrease: true };

/**
 * Seeds are a TRIPWIRE, not a gauge (plan D17): 5-10 mailboxes is not a sample
 * anyone should quote a percentage from. Medium confidence — small sample, but a
 * DIRECT observation of the spam folder rather than a proxy for one — and it
 * still counts toward an increase, because a clean placement sweep is real, if
 * coarse, evidence.
 *
 * THE LEVEL IS IMPORTED, NOT RESTATED. `SEED_GATE_CONFIDENCE` is declared beside
 * the roll-up that produces the reading (`@owlat/shared/seedPlacement`), so the
 * analytics surface and the controller's gate cannot put two different labels on
 * one measurement.
 */
export const SEED_TRIPWIRE: RampGateGrade = {
	confidence: SEED_GATE_CONFIDENCE,
	mayJustifyIncrease: true,
};

/**
 * A PROXY stands in for the thing we actually wanted to measure: one-click
 * unsubscribes where a complaint feedback loop would have told us about
 * complaints. Real evidence, honestly labelled as second-hand (plan D14), and it
 * still counts toward an increase.
 */
export const PROXY_MEASUREMENT: RampGateGrade = { confidence: 'medium', mayJustifyIncrease: true };

/**
 * THE ASYMMETRY, as a constant (plan D14). The standalone engagement check
 * compares this week against last month with subject, content, audience and
 * season all free to move, so it genuinely cannot tell a redesigned newsletter
 * from a placement loss. The response is not to pretend otherwise: it may cause a
 * DECREASE, and it may never be the evidence that justifies an INCREASE.
 */
export const WEAK_TRAILING_SIGNAL: RampGateGrade = {
	confidence: 'low',
	mayJustifyIncrease: false,
};

/** Confidence ordered worst-first, so an evaluation can report its weakest link. */
const CONFIDENCE_RANK: Readonly<Record<RampGateConfidence, number>> = {
	low: 0,
	medium: 1,
	high: 2,
};

/**
 * The measurement confidence of a SET of verdicts: the weakest one present. A
 * cell whose complaint signal is an unsubscribe proxy is a cell measured at
 * medium confidence, however high its bounce data is, and the UI must say so
 * (plan D14) rather than average the two into something reassuring.
 */
export function weakestConfidence(confidences: readonly RampGateConfidence[]): RampGateConfidence {
	let weakest: RampGateConfidence = 'high';
	for (const confidence of confidences) {
		if (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[weakest]) weakest = confidence;
	}
	return weakest;
}
