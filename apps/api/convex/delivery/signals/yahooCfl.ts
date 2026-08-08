/**
 * Which complaint signal the `yahoo` cell's gate 3 actually runs on (D2 / P3-8).
 *
 * Split out of `packages/shared/src/yahooCfl.ts` because it is a different
 * concern with a different owner: that module is the enrollment STATE MACHINE,
 * this one is the gate-input SUBSTITUTION the ramp reads — and P3-8's
 * substitution table subsumes exactly this file, not the state machine.
 *
 * It lives HERE, under `delivery/signals/` — one of the three provider
 * reputation feeds registered in `./registry` (seams plan D9) — rather than in
 * `@owlat/shared`, for one reason: the threshold it substitutes for is gate 3's,
 * and gate 3's threshold has exactly one home —
 * `RAMP_GATE_THRESHOLDS.complaintMax` in `../ramp/gateConfig`.
 * `packages/shared` cannot import from `apps/api`, so a copy in shared would be
 * a SECOND declaration of that number, and D5 is explicit that the controller
 * and the dashboard must never be able to disagree about a number. Absolute trip
 * points are branded `RateFraction` for the same reason units are a type-level
 * concern throughout the ramp.
 *
 * ONE RULE PER SOURCE, and it is the rule the running gate applies. What this
 * module publishes as `trip` is the same comparison
 * `evaluateStandaloneComplaintGate` (`../ramp/trailingBaselineGates`) performs — the
 * absolute `complaintMax` ceiling with a feedback loop, the 3x trailing-
 * unsubscribe multiple without one — read from the same constants. The dashboard
 * cannot state a trip point the controller does not enforce.
 *
 * ONE complaint pipeline, three sources. Absence of an enrollment substitutes a
 * weaker source with an honest confidence caveat; it never blanks the gate out,
 * never blocks anything, and never surfaces an error (D2 / D14).
 */

import type { YahooCflEnrollmentState } from '@owlat/shared/yahooCfl';
import { PROXY_MEASUREMENT } from '../ramp/gateGrades';
import { RAMP_GATE_THRESHOLDS, type RateFraction } from '../ramp/gateConfig';
import type { RampSubstituteSource } from '../ramp/degradationMatrix';
import { signalAbsent, signalPresent, type SignalAbsence, type SignalSource } from './types';

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
			 * `evaluateCeilingGate` in `../ramp/ceilingGate`: exactly the threshold PASSES.
			 */
			readonly thresholdRate: RateFraction;
	  }
	| {
			readonly kind: 'trailing_multiple';
			/**
			 * The multiple of the cell's OWN 30-day trailing rate of the SAME series
			 * at or above which the gate fails. Inclusive on the fail side — exactly
			 * `multiple x baseline` FAILS — matching `UNSUBSCRIBE_PROXY_SPEC`'s
			 * `boundary: 'inclusive_fail'` in `../ramp/trailingBaselineGates`.
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
	 * runs — `evaluateStandaloneComplaintGate` in `../ramp/trailingBaselineGates` —
	 * applies exactly this rule. The dashboard states what the controller
	 * enforces, or the two can disagree about a number (plan D5).
	 *
	 * `compareYahooComplaintRate` below is this field as code — consume it rather
	 * than re-deriving the comparison.
	 */
	trip: YahooComplaintTrip;
	/**
	 * HOW WELL WE ARE MEASURING **YAHOO** COMPLAINTS FOR THIS CELL — deliberately
	 * NOT the same question as the running gate's `grade.confidence`.
	 *
	 * The running gate grades a SOURCE in general (`CFBL_COMPLAINT_SPEC.grade` is
	 * `DIRECT_MEASUREMENT` / `high`: an RFC 9477 CFBL-Address feed is a real
	 * complaint feed, counted off our own wire). This field grades that source AS
	 * A STAND-IN FOR YAHOO, and Yahoo does not serve CFBL-Address — so for the
	 * yahoo cell specifically a CFBL feed is a partial view of the complaints we
	 * wanted, and it is graded one rank below the source's own grade.
	 *
	 * THE DIVERGENCE IS INTENDED AND IT IS PINNED. The `unsubscribe_rate_proxy`
	 * branch DOES equal `UNSUBSCRIBE_PROXY_SPEC.grade.confidence` (a proxy is a
	 * proxy in both framings) and a fixture asserts it, so do not read that as an
	 * invariant across all three branches: a second fixture asserts the
	 * `cfbl_address` branch sits exactly one rank below
	 * `CFBL_COMPLAINT_SPEC.grade.confidence`. Changing either side has to be a
	 * decision, not a drift. The two labels also render on different screens (this
	 * one on the Yahoo CFL wizard panel, the grade on the delivery measurement
	 * screens), so there is no operator-visible contradiction.
	 */
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
 * THREE-VALUED ON PURPOSE — "cannot tell" is not "fine".
 *
 * The running gate distinguishes `pass` from `own_rate_unmeasurable` from
 * `baseline_not_a_denominator`, because a hold has to NAME the thing to fix
 * (plan D12). A boolean comparator would fold the last two into the first, and
 * P3-8's substitution table — the consumer of this module — would read
 * "unmeasurable" as "healthy" and let a cell advance on a number nobody
 * actually has.
 *
 * `not_comparable` maps to a HOLD, never to a breach and never to a pass: the
 * comparison could not be built, so absence still blocks nothing (plan D2/D10).
 */
export type YahooComplaintComparison = 'breach' | 'no_breach' | 'not_comparable';

/**
 * Does gate 3 breach for the yahoo cell at this rate, under this substitution?
 *
 * The COMPARATOR that goes with `trip`. Published rather than left to each caller
 * for the reason a trip point without a comparator is only half a contract: two
 * of the three sources compare strictly and one compares inclusively, and until
 * that had an executable owner every consumer — P3-8's substitution table, the
 * dashboard, the tests — re-derived the boundary and could disagree about it.
 *
 * A non-finite OBSERVED rate is `not_comparable` on BOTH trip kinds — the
 * counters for the window could not be read as a rate at all, which is the
 * running gate's `own_rate_unmeasurable` hold, and an `Infinity` must not be
 * laundered into a confident breach against a real threshold.
 *
 * `ownTrailingRate` is the cell's own 30-day trailing rate of the same series,
 * and is only consulted by the `trailing_multiple` trip. A trailing rate that
 * cannot be a DENOMINATOR — absent, non-finite or zero — is `not_comparable`
 * too, matching the running gate's `baseline_not_a_denominator`.
 */
export function compareYahooComplaintRate(
	rate: RateFraction,
	substitution: YahooComplaintSubstitution,
	ownTrailingRate: RateFraction | null = null
): YahooComplaintComparison {
	const observed = rate as number;
	if (!Number.isFinite(observed)) return 'not_comparable';
	const { trip } = substitution;
	if (trip.kind === 'absolute_rate') {
		return observed > (trip.thresholdRate as number) ? 'breach' : 'no_breach';
	}
	const baseline = ownTrailingRate === null ? null : (ownTrailingRate as number);
	if (baseline === null || !Number.isFinite(baseline) || baseline <= 0) return 'not_comparable';
	return observed >= baseline * trip.multiple ? 'breach' : 'no_breach';
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
 * they already live in `../ramp/gateConfig` where the rest of the ramp reads them.
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
			// ONE RANK BELOW `CFBL_COMPLAINT_SPEC.grade.confidence` ON PURPOSE, and
			// pinned by a fixture. The feed itself is a direct measurement; it is a
			// PARTIAL view of YAHOO, which does not serve RFC 9477 CFBL-Address. See
			// the field docs on `YahooComplaintSubstitution.confidence`.
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

/** What this cell's enrollment state and CFBL-Address presence are. */
export interface YahooComplaintSignalInput {
	enrollmentState: YahooCflEnrollmentState;
	hasCfblAddress: boolean;
}

/**
 * The two sources that are a stand-in FOR the Yahoo feed rather than the feed.
 * `yahoo_cfl` is excluded because it is the feed itself, and a live Yahoo feed is
 * a PRESENT reading rather than a substitution for one.
 */
export type YahooStandIn = Exclude<YahooComplaintSignalSource, 'yahoo_cfl'>;

/**
 * This module's names for its stand-ins, in the ONE substitute vocabulary the
 * degradation table and the dashboard use (`RAMP_SUBSTITUTE_SOURCES`).
 *
 * The two vocabularies are separate on purpose — `YahooComplaintSignalSource`
 * answers "which of the three complaint pipelines is live for the yahoo cell",
 * `RampSubstituteSource` answers "what is any cell running on instead" — but a
 * registry entry that spelled the CFBL feed `cfbl_address` while every other
 * reader spells it `cfbl_address_reports` is one stand-in with two names, so the
 * translation happens once, here, at the boundary.
 */
export const YAHOO_ABSENCE_SUBSTITUTE: Readonly<Record<YahooStandIn, RampSubstituteSource>> = {
	cfbl_address: 'cfbl_address_reports',
	unsubscribe_rate_proxy: 'unsubscribe_rate_proxy',
};

/**
 * The absence, READ from the substitution that was actually picked — the
 * registry never states a stand-in the cell does not run on, and never restates
 * a sentence the substitution already owns. Only the NAME is translated, once,
 * through the table above.
 *
 * The source is passed separately because the caller is the one that established
 * it is not `yahoo_cfl`: a live Yahoo feed is a present reading, never a
 * stand-in for one, so it has no absence to build.
 */
function yahooAbsence(
	source: YahooStandIn,
	substitution: YahooComplaintSubstitution
): SignalAbsence {
	return {
		behaviour: 'substitute',
		substitutes: YAHOO_ABSENCE_SUBSTITUTE[source],
		note: substitution.confidenceNote,
		isBlocking: substitution.isBlocking,
	};
}

/**
 * What the yahoo cell runs on with NOTHING configured — no enrollment, no
 * CFBL-Address. The weakest of the two stand-ins, and therefore the one the
 * static declaration below states.
 */
const NOTHING_CONFIGURED = yahooComplaintSubstitution({
	enrollmentState: 'not_started',
	hasCfblAddress: false,
});

/**
 * Yahoo's Complaint Feed as a signal source (plan D9).
 *
 * PRESENT MEANS YAHOO'S OWN FEED, nothing weaker. The other two branches of
 * `yahooComplaintSubstitution` are exactly what this source's absence means: a
 * stand-in is live, the gate keeps running on it, and the cell says so at a
 * lower confidence. Reporting `cfbl_address` as a present Yahoo feed would be
 * the one misreading this module was split out to prevent — Yahoo does not serve
 * RFC 9477 CFBL-Address.
 *
 * ADVISORY, for the reason `./snds` is: `kind` says what a reading may do, and
 * this one moves nothing on its own. The complaint gate that DOES move the share
 * is the ramp's own `complaint_rate` source, which measures the cell's counters;
 * this feed names which signal those counters are standing on and at what
 * confidence.
 *
 * A `lapsed` enrollment is absent, exactly as `yahooComplaintSubstitution`
 * treats it: the point of the derived lapse is that the feed can no longer be
 * trusted to be live.
 *
 * TWO STAND-INS, AND THE FIELD STATES THE WEAKER ONE. `absence` is what a
 * deployment that configured NOTHING runs on — the unsubscribe-rate proxy. A
 * deployment that sends with a CFBL-Address substitutes the stronger
 * `cfbl_address_reports` instead, and only `collect()` knows which, because only
 * `collect()` is given the cell. An inventory reader wanting a particular cell's
 * stand-in has to ask `collect()`; this field answers the worst case.
 */
export const YAHOO_CFL_SIGNAL_SOURCE: SignalSource<
	YahooComplaintSignalInput,
	YahooComplaintSubstitution
> = {
	key: 'yahoo_cfl',
	kind: 'advisory',
	absence: yahooAbsence('unsubscribe_rate_proxy', NOTHING_CONFIGURED),
	collect(input: YahooComplaintSignalInput) {
		const substitution = yahooComplaintSubstitution(input);
		const source = substitution.source;
		return source === 'yahoo_cfl'
			? signalPresent(substitution)
			: signalAbsent<YahooComplaintSubstitution>(yahooAbsence(source, substitution));
	},
};
