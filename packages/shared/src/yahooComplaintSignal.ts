/**
 * Which complaint signal the `yahoo` cell's gate 3 actually runs on (D2 / P3-8).
 *
 * Split out of `yahooCfl.ts` because it is a different concern with a different
 * owner: that module is the enrollment STATE MACHINE, this one is the gate-input
 * SUBSTITUTION the ramp reads — and P3-8's substitution table subsumes exactly
 * this file, not the state machine.
 *
 * ONE complaint pipeline, three sources. Absence of an enrollment substitutes a
 * weaker source with an honest confidence caveat; it never blanks the gate out,
 * never blocks anything, and never surfaces an error (D2 / D14).
 */

import type { YahooCflEnrollmentState } from './yahooCfl';

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

/** Direct complaint evidence: the shipped 0.1% complaint-rate threshold. */
export const YAHOO_CFL_COMPLAINT_THRESHOLD = 0.001;

/**
 * The proxy threshold when no complaint feed exists at all. An unsubscribe is a
 * much weaker, much more common signal than a spam report, so the equivalent
 * trip point is TIGHTENED to 0.05% rather than reused at 0.1%.
 */
export const YAHOO_UNSUBSCRIBE_PROXY_THRESHOLD = 0.0005;

export interface YahooComplaintSubstitution {
	source: YahooComplaintSignalSource;
	/** The rate at or above which gate 3 fails for the yahoo cell. */
	thresholdRate: number;
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
 * Pick the live complaint source for the yahoo cell.
 *
 * Enrollment present → Yahoo's own CFL (high confidence). Otherwise fall back
 * to the RFC 9477 CFBL-Address feed when the send carried one (medium), and
 * failing that to the unsubscribe-rate proxy at the tightened threshold (low).
 * The confidence sentence is ALWAYS returned — a UI that had to supply the `high`
 * one itself would be a second home for the same copy, free to drift. There is no fourth branch: the gate ALWAYS has
 * a source, so absence can never surface as an error or an unresolvable warning.
 *
 * A `lapsed` enrollment is treated exactly like no enrollment — the point of the
 * derived lapse is that we can no longer trust the feed to be live.
 *
 * SCOPE NOTE (D3): P3-8 owns the ONE substitution table for every gate. When it
 * lands it SUBSUMES this function, and `YAHOO_CFL_COMPLAINT_THRESHOLD` /
 * `YAHOO_UNSUBSCRIBE_PROXY_THRESHOLD` move into it — they must not be
 * re-declared there, or the controller and this wizard would end up with two
 * disagreeing definitions of the yahoo complaint gate. Until then this is the
 * only definition, and it exists so the wizard can state the live source
 * honestly rather than showing a blank gate.
 */
export function yahooComplaintSubstitution(input: {
	enrollmentState: YahooCflEnrollmentState;
	hasCfblAddress: boolean;
}): YahooComplaintSubstitution {
	if (input.enrollmentState === 'enrolled') {
		return {
			source: 'yahoo_cfl',
			thresholdRate: YAHOO_CFL_COMPLAINT_THRESHOLD,
			confidence: 'high',
			confidenceNote:
				'Measurement confidence: high — Yahoo complaints for this domain are measured directly.',
			isBlocking: false,
		};
	}
	if (input.hasCfblAddress) {
		return {
			source: 'cfbl_address',
			thresholdRate: YAHOO_CFL_COMPLAINT_THRESHOLD,
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
		thresholdRate: YAHOO_UNSUBSCRIBE_PROXY_THRESHOLD,
		confidence: 'low',
		confidenceNote:
			'Measurement confidence: low — no Yahoo complaint feed, so unsubscribes stand in for complaints at a tighter threshold.',
		caveat:
			'Enrolling this domain in Yahoo’s Complaint Feedback Loop would measure complaints directly.',
		isBlocking: false,
	};
}
