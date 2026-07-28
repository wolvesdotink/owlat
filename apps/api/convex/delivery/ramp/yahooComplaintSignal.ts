/**
 * Which complaint signal the `yahoo` cell's gate 3 actually runs on (D2 / P3-8).
 *
 * Split out of `packages/shared/src/yahooCfl.ts` because it is a different
 * concern with a different owner: that module is the enrollment STATE MACHINE,
 * this one is the gate-input SUBSTITUTION the ramp reads — and P3-8's
 * substitution table subsumes exactly this file, not the state machine.
 *
 * It lives HERE, under `delivery/ramp/`, rather than in `@owlat/shared`, for one
 * reason: the threshold it substitutes for is gate 3's, and gate 3's threshold
 * has exactly one home — `RAMP_GATE_THRESHOLDS.complaintMax` in `./gateConfig`.
 * `packages/shared` cannot import from `apps/api`, so a copy in shared would be
 * a SECOND declaration of that number, and D5 is explicit that the controller
 * and the dashboard must never be able to disagree about a number. Absolute trip
 * points are branded `RateFraction` for the same reason units are a type-level
 * concern throughout the ramp.
 *
 * ONE RULE PER SOURCE, and it is the rule the running gate applies. What this
 * module publishes as `trip` is the same comparison
 * `evaluateStandaloneComplaintGate` (`./trailingBaselineGates`) performs — the
 * absolute `complaintMax` ceiling with a feedback loop, the 3x trailing-
 * unsubscribe multiple without one — read from the same constants. The dashboard
 * cannot state a trip point the controller does not enforce.
 *
 * ONE complaint pipeline, three sources. Absence of an enrollment substitutes a
 * weaker source with an honest confidence caveat; it never blanks the gate out,
 * never blocks anything, and never surfaces an error (D2 / D14).
 */

import type { YahooCflEnrollmentState } from '@owlat/shared/yahooCfl';
import { PROXY_MEASUREMENT } from './gateGrades';
import { RAMP_GATE_THRESHOLDS, type RateFraction } from './gateConfig';

/**
 * Which complaint signal the `yahoo` cell's gate 3 is actually running on.
 * ONE complaint pipeline, three sources — this names which one is live.
 */
export const YAHOO_COMPLAINT_SIGNAL_SOURCES = [
	'yahoo_cfl',
	'cfbl_address',
	'unsubscribe_rate_proxy',
] as const;
export type YahooComplaintSignalSource = (typeof YAHOO_COMPLAINT_SIGNAL_SOURCES)[number];

/**
 * WHERE THE TRIP POINT COMES FROM — a union, because the three sources do not
 * all compare against the same KIND of number.
 *
 * A complaint feed yields a rate with a hard industry meaning, so its trip point
 * is an ABSOLUTE ceiling. The unsubscribe proxy has no such meaning: unsubscribe
 * rates run an order of magnitude above complaint rates, so what carries signal
 * is not the level but the MOVE against the cell's own recent history. Flattening
 * the second into an absolute number is what produced two disagreeing definitions
 * of this gate; a union makes the difference unrepresentable.
 */
export type YahooComplaintTrip =
	| {
			readonly kind: 'absolute_rate';
			/**
			 * The rate ABOVE which gate 3 fails — pass iff `rate <= thresholdRate`,
			 * fail iff `rate > thresholdRate`. Strictly `>`, matching
			 * `evaluateCeilingGate` in `./ceilingGate`: exactly the threshold PASSES.
			 */
			readonly thresholdRate: RateFraction;
	  }
	| {
			readonly kind: 'trailing_multiple';
			/**
			 * The multiple of the cell's OWN 30-day trailing rate of the SAME series
			 * at or above which the gate fails. Inclusive on the fail side — exactly
			 * `multiple x baseline` FAILS — matching `UNSUBSCRIBE_PROXY_SPEC`'s
			 * `boundary: 'inclusive_fail'` in `./trailingBaselineGates`.
			 */
			readonly multiple: number;
			/** Which series both sides of the comparison are denominated in. */
			readonly series: 'unsubscribe_rate';
	  };

export interface YahooComplaintSubstitution {
	source: YahooComplaintSignalSource;
	/**
	 * THE ONE DEFINITION of the yahoo cell's gate-3 trip point.
	 *
	 * It is published rather than described because it is the contract P3-8
	 * consumes when it subsumes this function, and because the gate that ACTUALLY
	 * runs — `evaluateStandaloneComplaintGate` in `./trailingBaselineGates` —
	 * applies exactly this rule. The dashboard states what the controller
	 * enforces, or the two can disagree about a number (plan D5).
	 *
	 * `yahooComplaintGateFails` below is this field as code — consume it rather
	 * than re-deriving the comparison.
	 */
	trip: YahooComplaintTrip;
	confidence: 'high' | 'medium' | 'low';
	/**
	 * The confidence sentence shown on the cell, ALWAYS present — including the
	 * `high` branch. One family of operator copy with ONE home: a UI that had to
	 * supply the `high` sentence itself would be a second definition of the same
	 * fact, free to drift from this one.
	 */
	confidenceNote: string;
	/**
	 * The optional follow-on sentence suggesting how to IMPROVE the measurement.
	 * Present only when there is something to suggest (i.e. confidence is below
	 * `high`). It is a suggestion, never a warning and never a nag.
	 */
	caveat?: string;
	/**
	 * Always `false`. Encoded as a field rather than left implicit so the D2
	 * invariant is asserted by a test rather than assumed by a reader.
	 */
	isBlocking: false;
}

/**
 * Does gate 3 FAIL the yahoo cell at this rate, under this substitution?
 *
 * The COMPARATOR that goes with `trip`. Published rather than left to each caller
 * for the reason a trip point without a comparator is only half a contract: two
 * of the three sources compare strictly and one compares inclusively, and until
 * that had an executable owner every consumer — P3-8's substitution table, the
 * dashboard, the tests — re-derived the boundary and could disagree about it.
 *
 * `ownTrailingRate` is the cell's own 30-day trailing rate of the same series,
 * and is only consulted by the `trailing_multiple` trip. A trailing rate that
 * cannot be a DENOMINATOR — absent, non-finite or zero — is not a failure: it is
 * a comparison that cannot be built, which the running gate reports as
 * `baseline_not_a_denominator` and holds on (plan D10). Reporting `false` here
 * says "this rate is not a breach", which is the honest answer and the one that
 * keeps absence from blocking anything (plan D2).
 */
export function yahooComplaintGateFails(
	rate: RateFraction,
	substitution: YahooComplaintSubstitution,
	ownTrailingRate: RateFraction | null = null
): boolean {
	const observed = rate as number;
	if (!Number.isFinite(observed)) return false;
	const { trip } = substitution;
	if (trip.kind === 'absolute_rate') return observed > (trip.thresholdRate as number);
	const baseline = ownTrailingRate === null ? null : (ownTrailingRate as number);
	if (baseline === null || !Number.isFinite(baseline) || baseline <= 0) return false;
	return observed >= baseline * trip.multiple;
}

/**
 * Pick the live complaint source for the yahoo cell.
 *
 * Enrollment present → Yahoo's own CFL (high confidence). Otherwise fall back
 * to the RFC 9477 CFBL-Address feed when the send carried one (medium), and
 * failing that to the unsubscribe-rate proxy at 3x the cell's own trailing
 * unsubscribe rate (medium — it is a PROXY, and `PROXY_MEASUREMENT` is where that
 * grade is declared for every gate that runs on one).
 * The confidence sentence is ALWAYS returned — a UI that had to supply the `high`
 * one itself would be a second home for the same copy, free to drift. There is
 * no fourth branch: the gate ALWAYS has a source, so absence can never surface
 * as an error or an unresolvable warning.
 *
 * A `lapsed` enrollment is treated exactly like no enrollment — the point of the
 * derived lapse is that we can no longer trust the feed to be live.
 *
 * SCOPE NOTE (D3): P3-8 owns the ONE substitution table for every gate. When it
 * lands it SUBSUMES this function; the thresholds do NOT move with it, because
 * they already live in `./gateConfig` where the rest of the ramp reads them.
 */
export function yahooComplaintSubstitution(input: {
	enrollmentState: YahooCflEnrollmentState;
	hasCfblAddress: boolean;
}): YahooComplaintSubstitution {
	if (input.enrollmentState === 'enrolled') {
		return {
			source: 'yahoo_cfl',
			trip: { kind: 'absolute_rate', thresholdRate: RAMP_GATE_THRESHOLDS.complaintMax },
			confidence: 'high',
			confidenceNote:
				'Measurement confidence: high — Yahoo complaints for this domain are measured directly.',
			isBlocking: false,
		};
	}
	if (input.hasCfblAddress) {
		return {
			source: 'cfbl_address',
			trip: { kind: 'absolute_rate', thresholdRate: RAMP_GATE_THRESHOLDS.complaintMax },
			confidence: 'medium',
			confidenceNote:
				'Measurement confidence: medium — Yahoo complaints are counted from the CFBL-Address feed.',
			caveat:
				'Enrolling this domain in Yahoo’s Complaint Feedback Loop would measure complaints directly.',
			isBlocking: false,
		};
	}
	return {
		source: 'unsubscribe_rate_proxy',
		trip: {
			kind: 'trailing_multiple',
			multiple: RAMP_GATE_THRESHOLDS.unsubscribeProxyMultiple,
			series: 'unsubscribe_rate',
		},
		confidence: PROXY_MEASUREMENT.confidence,
		confidenceNote:
			'Measurement confidence: medium — no Yahoo complaint feed, so a sharp rise in one-click unsubscribes against this cell’s own recent history stands in for complaints.',
		caveat:
			'Enrolling this domain in Yahoo’s Complaint Feedback Loop would measure complaints directly.',
		isBlocking: false,
	};
}
