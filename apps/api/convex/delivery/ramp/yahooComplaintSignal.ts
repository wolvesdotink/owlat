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
 * and the dashboard must never be able to disagree about a number. Both trip
 * points are branded `RateFraction` for the same reason units are a type-level
 * concern throughout the ramp.
 *
 * ONE complaint pipeline, three sources. Absence of an enrollment substitutes a
 * weaker source with an honest confidence caveat; it never blanks the gate out,
 * never blocks anything, and never surfaces an error (D2 / D14).
 */

import type { YahooCflEnrollmentState } from '@owlat/shared/yahooCfl';
import {
	RAMP_GATE_THRESHOLDS,
	UNSUBSCRIBE_PROXY_COMPLAINT_MAX,
	type RateFraction,
} from './gateConfig';

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

export interface YahooComplaintSubstitution {
	source: YahooComplaintSignalSource;
	/**
	 * The rate ABOVE which gate 3 fails for the yahoo cell — pass iff
	 * `rate <= thresholdRate`, fail iff `rate > thresholdRate`.
	 *
	 * The boundary is stated explicitly because it is the contract P3-8 consumes
	 * when it subsumes this function, and because the shipped gate publishes a
	 * field of the SAME NAME with the SAME semantics (`evaluateCeilingGate` in
	 * `./gates` fails on `ownRate > threshold`, strictly). A rate of exactly the
	 * threshold PASSES, in both places. `yahooComplaintGateFails` below is that
	 * sentence as code — consume it rather than re-deriving the `>`.
	 */
	thresholdRate: RateFraction;
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
 * Does gate 3 FAIL the yahoo cell at this complaint rate, under this substitution?
 *
 * The COMPARATOR that goes with `thresholdRate`. Published rather than left to
 * each caller for the reason a threshold without a comparator is only half a
 * contract: `thresholdRate`'s docblock promises "pass iff `rate <= thresholdRate`",
 * and until that sentence had an executable owner every consumer — P3-8's
 * substitution table, the dashboard, the tests — re-derived the same `>` and
 * could disagree about the boundary. Now there is one implementation to consume
 * and one to break if the boundary ever moves.
 *
 * Strict `>`, matching `evaluateCeilingGate` in `./gates` exactly: a rate of
 * EXACTLY the threshold PASSES.
 */
export function yahooComplaintGateFails(
	rate: RateFraction,
	substitution: YahooComplaintSubstitution
): boolean {
	return (rate as number) > (substitution.thresholdRate as number);
}

/**
 * Pick the live complaint source for the yahoo cell.
 *
 * Enrollment present → Yahoo's own CFL (high confidence). Otherwise fall back
 * to the RFC 9477 CFBL-Address feed when the send carried one (medium), and
 * failing that to the unsubscribe-rate proxy at the tightened threshold (low).
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
			thresholdRate: RAMP_GATE_THRESHOLDS.complaintMax,
			confidence: 'high',
			confidenceNote:
				'Measurement confidence: high — Yahoo complaints for this domain are measured directly.',
			isBlocking: false,
		};
	}
	if (input.hasCfblAddress) {
		return {
			source: 'cfbl_address',
			thresholdRate: RAMP_GATE_THRESHOLDS.complaintMax,
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
		thresholdRate: UNSUBSCRIBE_PROXY_COMPLAINT_MAX,
		confidence: 'low',
		confidenceNote:
			'Measurement confidence: low — no Yahoo complaint feed, so unsubscribes stand in for complaints at a tighter threshold.',
		caveat:
			'Enrolling this domain in Yahoo’s Complaint Feedback Loop would measure complaints directly.',
		isBlocking: false,
	};
}
