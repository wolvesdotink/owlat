/**
 * P4-6 D2 proof — a deployment with NO Yahoo CFL enrollment.
 *
 * The additive-only third-party rule: absence of the enrollment may lower
 * measurement confidence and slow the ramp, and must do NOTHING else. It never
 * throws, never blocks a send, never blocks a phase promotion, never surfaces an
 * error state, and never renders an unresolvable warning or a "setup incomplete"
 * nag. Un-enrolled falls back to the documented substitution (the CFBL feed if
 * a send carried one, otherwise the unsubscribe-rate proxy at 3x the cell's own
 * trailing unsubscribe rate) and says so as a confidence caveat.
 *
 * SCOPE: `yahooComplaintSubstitution` is the yahoo cell's only definition today.
 * P3-8 lands the ONE substitution table for every gate and SUBSUMES it — so
 * these assertions move there rather than being duplicated, or we end up with
 * two disagreeing yahoo complaint gates (D3). The THRESHOLDS do not move: they
 * already live in `../gateConfig` alongside every other ramp threshold, which is
 * why this suite reads them from there rather than from a second declaration.
 */

import { describe, expect, it } from 'vitest';
import {
	YAHOO_CFL_ENROLLMENT_STATES,
	yahooCflGuidedSteps,
	emptyYahooCflEnrollment,
	type YahooCflEnrollmentState,
} from '@owlat/shared/yahooCfl';
import { RAMP_GATE_THRESHOLDS, rateFraction } from '../gateConfig';
import { PROXY_MEASUREMENT } from '../gateGrades';
import { evaluateComplaintGate } from '../gates';
import { UNSUBSCRIBE_PROXY_SPEC } from '../trailingBaselineGates';
import {
	YAHOO_COMPLAINT_SIGNAL_SOURCES,
	yahooComplaintGateFails,
	yahooComplaintSubstitution,
} from '../yahooComplaintSignal';
import { arm, input, itEquipped } from './gateFixtures';

const UNENROLLED_STATES: YahooCflEnrollmentState[] = ['not_started', 'awaiting_yahoo', 'lapsed'];

describe('the substitution table always yields a usable gate', () => {
	it('enumerates exactly three complaint sources', () => {
		expect(YAHOO_COMPLAINT_SIGNAL_SOURCES).toEqual([
			'yahoo_cfl',
			'cfbl_address',
			'unsubscribe_rate_proxy',
		]);
	});

	it('uses Yahoo CFL at full confidence when enrolled', () => {
		expect(
			yahooComplaintSubstitution({ enrollmentState: 'enrolled', hasCfblAddress: false })
		).toEqual({
			source: 'yahoo_cfl',
			trip: { kind: 'absolute_rate', thresholdRate: RAMP_GATE_THRESHOLDS.complaintMax },
			confidence: 'high',
			confidenceNote:
				'Measurement confidence: high — Yahoo complaints for this domain are measured directly.',
			isBlocking: false,
		});
	});

	it('falls back to the CFBL feed at medium confidence when un-enrolled', () => {
		for (const enrollmentState of UNENROLLED_STATES) {
			const result = yahooComplaintSubstitution({ enrollmentState, hasCfblAddress: true });
			expect(result.source).toBe('cfbl_address');
			expect(result.confidence).toBe('medium');
			expect(result.trip).toEqual({
				kind: 'absolute_rate',
				thresholdRate: RAMP_GATE_THRESHOLDS.complaintMax,
			});
			expect(result.confidenceNote).toContain('Measurement confidence: medium');
		}
	});

	it('falls back to the RELATIVE unsubscribe proxy with no feed at all', () => {
		for (const enrollmentState of UNENROLLED_STATES) {
			const result = yahooComplaintSubstitution({ enrollmentState, hasCfblAddress: false });
			expect(result.source).toBe('unsubscribe_rate_proxy');
			expect(result.confidence).toBe('medium');
			expect(result.trip).toEqual({
				kind: 'trailing_multiple',
				multiple: RAMP_GATE_THRESHOLDS.unsubscribeProxyMultiple,
				series: 'unsubscribe_rate',
			});
			expect(result.confidenceNote).toContain('Measurement confidence: medium');
		}
	});

	/**
	 * THE ANTI-DIVERGENCE FIXTURE (plan D5). This module publishes the trip point
	 * the WIZARD renders; `UNSUBSCRIBE_PROXY_SPEC` is the rule the CONTROLLER
	 * actually applies. They were once two numbers with two confidence labels —
	 * an absolute 0.05% ceiling at low confidence here, a 3x relative rule at
	 * medium confidence there — and a standalone yahoo cell with no feedback loop
	 * hit both. This pins them to one rule, one multiple, one boundary and one
	 * grade, so a change to either side that does not move the other fails here.
	 */
	it('publishes exactly the rule the running gate applies', () => {
		const published = yahooComplaintSubstitution({
			enrollmentState: 'not_started',
			hasCfblAddress: false,
		});
		expect(published.trip.kind).toBe('trailing_multiple');
		// No absolute ceiling on either side: an unsubscribe rate is an order of
		// magnitude above a complaint rate, so a complaint-scale ceiling would fail
		// every cell that has ever sent mail.
		expect(UNSUBSCRIBE_PROXY_SPEC.thresholdOf(RAMP_GATE_THRESHOLDS)).toBeNull();
		const comparison = UNSUBSCRIBE_PROXY_SPEC.secondSeries?.comparison;
		if (comparison?.kind !== 'multiple') throw new Error('the proxy spec compares a multiple');
		expect(comparison.boundary).toBe('inclusive_fail');
		expect(comparison.of(RAMP_GATE_THRESHOLDS)).toBe(
			published.trip.kind === 'trailing_multiple' ? published.trip.multiple : null
		);
		// ONE confidence label for one rule.
		expect(published.confidence).toBe(UNSUBSCRIBE_PROXY_SPEC.grade.confidence);
		expect(published.confidence).toBe(PROXY_MEASUREMENT.confidence);
	});

	it('never blocks and never errors, in EVERY state and both feed configurations', () => {
		for (const enrollmentState of YAHOO_CFL_ENROLLMENT_STATES) {
			for (const hasCfblAddress of [true, false]) {
				const result = yahooComplaintSubstitution({ enrollmentState, hasCfblAddress });
				expect(result.isBlocking).toBe(false);
				// A source is ALWAYS resolved: there is no "no signal" branch that a
				// caller could interpret as an error or an unresolvable warning.
				expect(YAHOO_COMPLAINT_SIGNAL_SOURCES).toContain(result.source);
				// A trip point is ALWAYS resolved, and it is always usable: an absolute
				// ceiling of zero or a multiple of zero would fail every cell.
				expect(
					result.trip.kind === 'absolute_rate'
						? (result.trip.thresholdRate as number)
						: result.trip.multiple
				).toBeGreaterThan(0);
				// The confidence sentence has ONE home — the pure function — so a UI can
				// render it unconditionally and can never drift from this copy.
				expect(result.confidenceNote).toContain('Measurement confidence:');
			}
		}
	});

	it('caveats confidence rather than reporting a problem', () => {
		const result = yahooComplaintSubstitution({
			enrollmentState: 'not_started',
			hasCfblAddress: false,
		});
		// The copy is a confidence statement plus an optional improvement — never
		// "error", "failed", "required", "incomplete", or "action needed".
		const forbidden = ['error', 'failed', 'required', 'incomplete', 'action needed', 'must'];
		for (const word of forbidden) {
			expect(result.confidenceNote.toLowerCase()).not.toContain(word);
			expect(result.caveat?.toLowerCase()).not.toContain(word);
		}
		expect(result.caveat).toContain('would measure complaints directly');
	});

	it('only the enrolled state gets high confidence', () => {
		for (const enrollmentState of UNENROLLED_STATES) {
			expect(
				yahooComplaintSubstitution({ enrollmentState, hasCfblAddress: true }).confidence
			).not.toBe('high');
		}
	});
});

/**
 * `thresholdRate` + `yahooComplaintGateFails` are the contract P3-8 consumes,
 * and the shipped gate publishes a field of the same name — so the comparison
 * boundary is pinned rather than left to the reader. Gate 3 is
 * `complaint <= 0.1%`: exactly the threshold PASSES, anything above it fails.
 * The rates here are injected as summary overrides because an integer numerator
 * cannot express a rate a hair over the threshold.
 *
 * The proxy half calls the SHIPPED comparator, not a local re-declaration of
 * `>`: a helper that re-implements the operator under test compares `a > b`
 * against itself and can never fail.
 */
describe('the comparison boundary is inclusive on the pass side', () => {
	/**
	 * The shipped gate 3, evaluated at a chosen own-arm complaint rate. Both arms
	 * carry the SAME rate so the comparative half is always satisfied and the only
	 * thing under test is the absolute-ceiling comparison.
	 */
	function complaintVerdict(rate: number) {
		return evaluateComplaintGate(
			input({
				own: arm({ sent: 100_000 }, { complaintRate: rate }),
				reference: arm({ sent: 100_000 }, { complaintRate: rate }),
			})
		).status;
	}

	/** The shipped comparator, applied to the substitution the given state selects. */
	function substitutionFails(
		enrollmentState: YahooCflEnrollmentState,
		rate: number,
		trailingRate: number | null = null
	): boolean {
		return yahooComplaintGateFails(
			rateFraction(rate),
			yahooComplaintSubstitution({ enrollmentState, hasCfblAddress: false }),
			trailingRate === null ? null : rateFraction(trailingRate)
		);
	}

	const DIRECT = RAMP_GATE_THRESHOLDS.complaintMax as number;
	const MULTIPLE = RAMP_GATE_THRESHOLDS.unsubscribeProxyMultiple;
	/** A hair over a threshold — far more than one ulp, small enough to be a boundary probe. */
	const JUST_ABOVE = 0.0000000001;
	/** A plausible trailing unsubscribe rate for a healthy list: a few tenths of a percent. */
	const TRAILING_UNSUBSCRIBE = 0.002;

	// THE REFERENCE-ARM HALF. `complaintVerdict` builds a two-armed cell, which the
	// standalone leg of the gate matrix has no way to produce — the fixture guard
	// refuses it rather than letting the degraded path be tested on data it will
	// never see. The substitution assertions below stay in plain `it` and run in
	// BOTH legs, because the substitution is exactly what the standalone leg is for.
	itEquipped('passes at exactly the direct threshold and fails just above it', () => {
		expect(complaintVerdict(DIRECT)).toBe('pass');
		expect(complaintVerdict(DIRECT + JUST_ABOVE)).toBe('fail');
	});

	it('publishes the trip point the shipped gate compares against', () => {
		const enrolled = yahooComplaintSubstitution({
			enrollmentState: 'enrolled',
			hasCfblAddress: false,
		});
		expect(enrolled.trip).toEqual({ kind: 'absolute_rate', thresholdRate: DIRECT });
		expect(substitutionFails('enrolled', DIRECT)).toBe(false);
		expect(substitutionFails('enrolled', DIRECT + JUST_ABOVE)).toBe(true);
	});

	it('fails the proxy AT the multiple of the cell’s own trailing rate, not above it', () => {
		const trip = MULTIPLE * TRAILING_UNSUBSCRIBE;
		// `inclusive_fail`, matching UNSUBSCRIBE_PROXY_SPEC: exactly 3x FAILS.
		expect(substitutionFails('not_started', trip, TRAILING_UNSUBSCRIBE)).toBe(true);
		expect(substitutionFails('not_started', trip - JUST_ABOVE, TRAILING_UNSUBSCRIBE)).toBe(false);
	});

	it('never trips the proxy on a trailing rate that cannot be a denominator', () => {
		// Absent, zero and non-finite baselines are a comparison that cannot be
		// built — the running gate HOLDS on them (D10), so the published comparator
		// must not report a breach either.
		for (const trailing of [null, 0, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			expect(substitutionFails('not_started', 0.9, trailing)).toBe(false);
		}
	});

	it('ignores the trailing rate entirely on an absolute trip point', () => {
		// The baseline is an argument of the COMPARATOR, not of the trip point: a
		// feedback-loop cell compares against 0.1% whatever its history says.
		expect(substitutionFails('enrolled', DIRECT + JUST_ABOVE, 1)).toBe(true);
		expect(substitutionFails('enrolled', DIRECT, 0)).toBe(false);
	});
});

describe('the guided flow on a never-enrolled install', () => {
	it('renders cleanly with zero credentials and an unverified domain', () => {
		const steps = yahooCflGuidedSteps(
			emptyYahooCflEnrollment(),
			{ domain: 'mail.example.com', isVerified: false },
			Date.UTC(2026, 6, 1)
		);
		expect(steps).toHaveLength(4);
		for (const step of steps) {
			// `blocked` is a sequencing statement ("do the earlier step first"), the
			// vocabulary has no error/failure status at all.
			expect(['blocked', 'todo', 'in_progress', 'done']).toContain(step.status);
			expect(step.action).not.toContain('undefined');
			expect(step.verification).not.toContain('undefined');
		}
	});

	it('treats a DERIVED lapse exactly like no enrollment', () => {
		// The point of the derived lapse is that the feed can no longer be trusted
		// to be live, so the gate substitutes rather than keeping a stale verdict.
		expect(
			yahooComplaintSubstitution({ enrollmentState: 'lapsed', hasCfblAddress: false }).source
		).toBe('unsubscribe_rate_proxy');
	});

	it('treats not_started as a supported configuration, not an unfinished setup', () => {
		const record = emptyYahooCflEnrollment();
		expect(record.state).toBe('not_started');
		// Nothing about the default record is nag-shaped: no due date, no counter,
		// no error field. It is simply the absence of an optional integration.
		expect(Object.keys(record)).toEqual(['state']);
	});
});
