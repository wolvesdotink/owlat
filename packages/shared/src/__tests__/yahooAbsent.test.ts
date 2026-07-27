/**
 * P4-6 D2 proof — a deployment with NO Yahoo CFL enrollment.
 *
 * The additive-only third-party rule: absence of the enrollment may lower
 * measurement confidence and slow the ramp, and must do NOTHING else. It never
 * throws, never blocks a send, never blocks a phase promotion, never surfaces an
 * error state, and never renders an unresolvable warning or a "setup incomplete"
 * nag. Un-enrolled falls back to the documented substitution (the CFBL feed if
 * a send carried one, otherwise the unsubscribe-rate proxy at the tightened
 * 0.05% equivalent threshold) and says so as a confidence caveat.
 *
 * SCOPE: `yahooComplaintSubstitution` is the yahoo cell's only definition today.
 * P3-8 lands the ONE substitution table for every gate and SUBSUMES it, taking
 * the two thresholds with it — so these assertions move there rather than being
 * duplicated, or we end up with two disagreeing yahoo complaint gates (D3).
 */

import { describe, expect, it } from 'vitest';
import {
	YAHOO_CFL_COMPLAINT_THRESHOLD,
	YAHOO_CFL_ENROLLMENT_STATES,
	YAHOO_COMPLAINT_SIGNAL_SOURCES,
	YAHOO_UNSUBSCRIBE_PROXY_THRESHOLD,
	yahooCflGuidedSteps,
	yahooComplaintSubstitution,
	emptyYahooCflEnrollment,
	type YahooCflEnrollmentState,
} from '../yahooCfl';

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
			thresholdRate: YAHOO_CFL_COMPLAINT_THRESHOLD,
			confidence: 'high',
			isBlocking: false,
		});
	});

	it('falls back to the CFBL feed at medium confidence when un-enrolled', () => {
		for (const enrollmentState of UNENROLLED_STATES) {
			const result = yahooComplaintSubstitution({ enrollmentState, hasCfblAddress: true });
			expect(result.source).toBe('cfbl_address');
			expect(result.confidence).toBe('medium');
			expect(result.thresholdRate).toBe(YAHOO_CFL_COMPLAINT_THRESHOLD);
			expect(result.caveat).toContain('Measurement confidence: medium');
		}
	});

	it('falls back to the unsubscribe proxy at the TIGHTENED threshold with no feed at all', () => {
		for (const enrollmentState of UNENROLLED_STATES) {
			const result = yahooComplaintSubstitution({ enrollmentState, hasCfblAddress: false });
			expect(result.source).toBe('unsubscribe_rate_proxy');
			expect(result.confidence).toBe('low');
			expect(result.thresholdRate).toBe(YAHOO_UNSUBSCRIBE_PROXY_THRESHOLD);
			expect(result.caveat).toContain('Measurement confidence: low');
		}
	});

	it('tightens the proxy to the 0.05% equivalent of the 0.1% direct threshold', () => {
		expect(YAHOO_CFL_COMPLAINT_THRESHOLD).toBe(0.001);
		expect(YAHOO_UNSUBSCRIBE_PROXY_THRESHOLD).toBe(0.0005);
		expect(YAHOO_UNSUBSCRIBE_PROXY_THRESHOLD).toBeLessThan(YAHOO_CFL_COMPLAINT_THRESHOLD);
	});

	it('never blocks and never errors, in EVERY state and both feed configurations', () => {
		for (const enrollmentState of YAHOO_CFL_ENROLLMENT_STATES) {
			for (const hasCfblAddress of [true, false]) {
				const result = yahooComplaintSubstitution({ enrollmentState, hasCfblAddress });
				expect(result.isBlocking).toBe(false);
				// A source is ALWAYS resolved: there is no "no signal" branch that a
				// caller could interpret as an error or an unresolvable warning.
				expect(YAHOO_COMPLAINT_SIGNAL_SOURCES).toContain(result.source);
				expect(result.thresholdRate).toBeGreaterThan(0);
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
