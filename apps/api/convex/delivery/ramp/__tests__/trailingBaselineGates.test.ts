/**
 * THE SUBSTITUTION TABLE, gate by gate (plan D2, D10, D14).
 *
 * One table per gate against the plan's "gates, degraded honestly" thresholds:
 * the 1.5x-trailing bounce rule, the 3x-trailing unsubscribe proxy, and the
 * 0.85 / 7-day / 2000-send engagement rule. Every case states the counts and the
 * verdict; nothing here asserts on an implementation detail.
 */

import { describe, expect, it } from 'vitest';
import { ENGAGEMENT_GATE_THRESHOLDS } from '../engagementConfig';
import { RAMP_GATE_SAMPLE_FLOORS, RAMP_GATE_THRESHOLDS } from '../gateConfig';
import type { RampGateResult } from '../gateTypes';
import {
	evaluateStandaloneComplaintGate,
	evaluateStandaloneSeedPlacementGate,
	evaluateTrailingEngagementGate,
	evaluateTrailingHardBounceGate,
} from '../trailingBaselineGates';
import { NOW, arm, engagementInput, input, seeds, standaloneInput } from './gateFixtures';

const DAY_MS = 24 * 60 * 60 * 1000;

// ============================ gate 1 — hard bounce ==========================

describe('gate 1 — hard bounce against the cell’s own trailing rate', () => {
	interface BounceCase {
		readonly name: string;
		readonly ownSent: number;
		readonly ownHardBounced: number;
		readonly trailing: { readonly sent: number; readonly hardBounced: number } | null;
		readonly status: RampGateResult['status'];
		readonly reason: RampGateResult['reason'];
	}

	const cases: readonly BounceCase[] = [
		{
			name: 'flat against the trailing rate passes',
			ownSent: 10_000,
			ownHardBounced: 100,
			trailing: { sent: 40_000, hardBounced: 400 },
			status: 'pass',
			reason: 'within_threshold',
		},
		{
			name: 'a 1.2x move is inside the 1.5x allowance',
			ownSent: 10_000,
			ownHardBounced: 120,
			trailing: { sent: 40_000, hardBounced: 400 },
			status: 'pass',
			reason: 'within_threshold',
		},
		{
			name: 'a 1.6x move breaches the trailing baseline',
			ownSent: 10_000,
			ownHardBounced: 160,
			trailing: { sent: 40_000, hardBounced: 400 },
			status: 'fail',
			reason: 'trailing_baseline_breached',
		},
		{
			name: 'the absolute 2% ceiling still fails even when the trailing rate is worse',
			ownSent: 10_000,
			ownHardBounced: 250,
			trailing: { sent: 40_000, hardBounced: 2_000 },
			status: 'fail',
			reason: 'absolute_threshold_breached',
		},
		{
			name: 'no trailing baseline holds — a young cell is never failed for being young',
			ownSent: 10_000,
			ownHardBounced: 100,
			trailing: null,
			status: 'insufficient_data',
			reason: 'evidence_absent',
		},
		{
			name: 'a thin own window holds',
			ownSent: 100,
			ownHardBounced: 1,
			trailing: { sent: 40_000, hardBounced: 400 },
			status: 'insufficient_data',
			reason: 'own_sample_below_floor',
		},
		{
			name: 'a thin trailing window holds against the BASELINE vocabulary, not the relay one',
			ownSent: 10_000,
			ownHardBounced: 100,
			trailing: { sent: 100, hardBounced: 1 },
			status: 'insufficient_data',
			reason: 'baseline_sample_below_floor',
		},
		// ---- THE BOUNDARY ITSELF: the plan says "AT MOST 1.5x", so 1.5x passes. ----
		{
			name: 'exactly 1.5x the trailing rate passes — the allowance is inclusive',
			ownSent: 10_000,
			ownHardBounced: 150,
			trailing: { sent: 40_000, hardBounced: 400 },
			status: 'pass',
			reason: 'within_threshold',
		},
		{
			name: 'one send past 1.5x fails',
			ownSent: 10_000,
			ownHardBounced: 151,
			trailing: { sent: 40_000, hardBounced: 400 },
			status: 'fail',
			reason: 'trailing_baseline_breached',
		},
		{
			name: 'exactly on the 2% absolute ceiling passes',
			ownSent: 10_000,
			ownHardBounced: 200,
			trailing: { sent: 40_000, hardBounced: 800 },
			status: 'pass',
			reason: 'within_threshold',
		},
		{
			name: 'one send past the 2% absolute ceiling fails',
			ownSent: 10_000,
			ownHardBounced: 201,
			trailing: { sent: 40_000, hardBounced: 804 },
			status: 'fail',
			reason: 'absolute_threshold_breached',
		},
		// ---- A BASELINE THAT CANNOT BE A DENOMINATOR ----
		{
			name: 'a trailing window with ZERO hard bounces HOLDS: 1.5x of nothing is not a ceiling',
			// A large, fresh, perfectly clean month is not evidence that one bounce in
			// ten thousand — two orders of magnitude inside the absolute ceiling — is a
			// reason to halve the share.
			ownSent: 10_000,
			ownHardBounced: 1,
			trailing: { sent: 40_000, hardBounced: 0 },
			status: 'insufficient_data',
			// NOT `baseline_rate_unmeasurable`: the trailing rate is a perfectly good
			// number (exactly 0). It is the DERIVED CEILING that cannot decide, and the
			// audit row must not tell the operator their clean window is corrupt.
			reason: 'baseline_not_a_denominator',
		},
		{
			name: 'a zero-rate baseline does not suppress the ABSOLUTE breach either',
			ownSent: 10_000,
			ownHardBounced: 300,
			trailing: { sent: 40_000, hardBounced: 0 },
			status: 'fail',
			reason: 'absolute_threshold_breached',
		},
	];

	for (const testCase of cases) {
		it(testCase.name, () => {
			const result = evaluateTrailingHardBounceGate(
				input({
					own: arm({ sent: testCase.ownSent, hardBounced: testCase.ownHardBounced }),
					ownTrailingBaseline: testCase.trailing ? arm(testCase.trailing) : null,
				})
			);
			expect(result.status).toBe(testCase.status);
			expect(result.reason).toBe(testCase.reason);
			expect(result.confidence).toBe('high');
		});
	}

	it('reports the 1.5x multiple as a ratio CEILING, never as a percentage-point tolerance', () => {
		const result = evaluateTrailingHardBounceGate(standaloneInput());
		expect(result.measurement.ratioCeiling).toBe(RAMP_GATE_THRESHOLDS.hardBounceTrailingMultiple);
		expect(result.measurement.toleranceValuePp).toBeNull();
	});

	it('a trailing window inside the 33-day baseline allowance is still fresh evidence', () => {
		const result = evaluateTrailingHardBounceGate(
			input({
				own: arm({ sent: 10_000, hardBounced: 100 }),
				ownTrailingBaseline: arm({
					sent: 40_000,
					hardBounced: 400,
					lastRecordedAt: NOW - 20 * DAY_MS,
				}),
			})
		);
		expect(result.status).toBe('pass');
	});

	it('a trailing window older than the baseline allowance holds', () => {
		const result = evaluateTrailingHardBounceGate(
			input({
				own: arm({ sent: 10_000, hardBounced: 100 }),
				ownTrailingBaseline: arm({
					sent: 40_000,
					hardBounced: 400,
					lastRecordedAt: NOW - 40 * DAY_MS,
				}),
			})
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('baseline_evidence_stale');
	});
});

// ============================= gate 3 — complaint ===========================

describe('gate 3 — complaints, or the unsubscribe proxy when there is no feedback loop', () => {
	function complaintGate(overrides: Parameters<typeof input>[0]): RampGateResult {
		return evaluateStandaloneComplaintGate(input(overrides));
	}

	it('WITH a feedback loop: the shipped absolute ceiling decides on its own', () => {
		const result = complaintGate({
			own: arm({ sent: 10_000, complained: 5 }),
			hasComplaintFeedback: true,
		});
		expect(result.status).toBe('pass');
		expect(result.confidence).toBe('high');
		// No second series was consulted: a real complaint rate is interpretable on
		// its own, and demanding 30 days of history would silence a young cell.
		expect(result.measurement.referenceSample).toBeNull();
	});

	it('WITH a feedback loop: over 0.1% fails', () => {
		const result = complaintGate({
			own: arm({ sent: 10_000, complained: 20 }),
			hasComplaintFeedback: true,
		});
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('absolute_threshold_breached');
	});

	it('WITHOUT one: a flat unsubscribe rate passes, at MEDIUM confidence and labelled a proxy', () => {
		const result = complaintGate({
			own: arm({ sent: 10_000, unsubscribed: 30 }),
			ownTrailingBaseline: arm({ sent: 40_000, unsubscribed: 120 }),
		});
		expect(result.status).toBe('pass');
		expect(result.confidence).toBe('medium');
	});

	it('WITHOUT one: a 2.5x unsubscribe move is inside the 3x allowance', () => {
		const result = complaintGate({
			own: arm({ sent: 10_000, unsubscribed: 75 }),
			ownTrailingBaseline: arm({ sent: 40_000, unsubscribed: 120 }),
		});
		expect(result.status).toBe('pass');
	});

	it('WITHOUT one: a 3.5x unsubscribe move is a complaint-equivalent breach', () => {
		const result = complaintGate({
			own: arm({ sent: 10_000, unsubscribed: 105 }),
			ownTrailingBaseline: arm({ sent: 40_000, unsubscribed: 120 }),
		});
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('trailing_baseline_breached');
		expect(result.confidence).toBe('medium');
	});

	it('WITHOUT one: the absolute COMPLAINT ceiling is never applied to unsubscribes', () => {
		// 0.3% unsubscribes is three times the 0.1% complaint ceiling and is an
		// entirely ordinary rate for a healthy list. Applying the complaint number
		// to the proxy would fail every cell that has ever sent mail.
		const ordinary = complaintGate({
			own: arm({ sent: 10_000, unsubscribed: 30 }),
			ownTrailingBaseline: arm({ sent: 40_000, unsubscribed: 120 }),
		});
		expect(ordinary.status).toBe('pass');
		expect(ordinary.measurement.ownRate).toBeGreaterThan(RAMP_GATE_THRESHOLDS.complaintMax);
	});

	it('WITHOUT one: EXACTLY 3x is a breach — the plan says "at or above 3x"', () => {
		// Counts chosen so both rates are exactly representable and base * 3 is
		// exactly the own rate: this case is about the comparison operator, and a
		// rounding artefact would decide it instead.
		const result = complaintGate({
			own: arm({ sent: 16_384, unsubscribed: 48 }),
			ownTrailingBaseline: arm({ sent: 32_768, unsubscribed: 32 }),
		});
		expect(result.measurement.ownRate).toBe(
			(result.measurement.referenceRate ?? 0) * RAMP_GATE_THRESHOLDS.unsubscribeProxyMultiple
		);
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('trailing_baseline_breached');
	});

	it('WITHOUT one: one unsubscribe short of 3x still passes', () => {
		const result = complaintGate({
			own: arm({ sent: 16_384, unsubscribed: 47 }),
			ownTrailingBaseline: arm({ sent: 32_768, unsubscribed: 32 }),
		});
		expect(result.status).toBe('pass');
	});

	it('WITHOUT one: a trailing window with ZERO unsubscribes HOLDS, never fails', () => {
		// The proxy has no absolute ceiling, so a zero baseline would fail this cell
		// on its FIRST unsubscribe — and a young standalone cell is exactly the
		// population the substitution exists for.
		const result = complaintGate({
			own: arm({ sent: 10_000, unsubscribed: 1 }),
			ownTrailingBaseline: arm({ sent: 40_000, unsubscribed: 0 }),
		});
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('baseline_not_a_denominator');
	});

	it('WITHOUT one: an implausible baseline buys silence, never permission', () => {
		// A relative-only gate whose implied ceiling reaches 1 can never fail
		// anything — so a poisoned or absurd baseline would hand the cell an
		// unfalsifiable pass, and an unfalsifiable pass counts toward an increase.
		const result = complaintGate({
			own: arm({ sent: 10_000, unsubscribed: 9_000 }),
			ownTrailingBaseline: arm({ sent: 40_000, unsubscribed: 30_000 }),
		});
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('baseline_not_a_denominator');
	});

	it('WITHOUT one: no trailing baseline holds rather than failing', () => {
		const result = complaintGate({ own: arm({ sent: 10_000, unsubscribed: 30 }) });
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('evidence_absent');
	});
});

// ============================ gate 4 — engagement ===========================

describe('gate 4 — trailing-baseline engagement (0.85 / 7 days / 2000 sends)', () => {
	function engagement(recentOpened: number, recentSent: number, baselineOpened: number) {
		return evaluateTrailingEngagementGate(
			engagementInput({
				own: arm({
					sent: recentSent,
					calibrationSent: recentSent,
					calibrationOpened: recentOpened,
				}),
				ownRecent: arm({
					sent: recentSent,
					calibrationSent: recentSent,
					calibrationOpened: recentOpened,
				}),
				ownPriorBaseline: arm({
					sent: 10_000,
					calibrationSent: 10_000,
					calibrationOpened: baselineOpened,
				}),
			})
		);
	}

	it('the constants are the plan’s relaxed ones, not the concurrent gate’s', () => {
		expect(ENGAGEMENT_GATE_THRESHOLDS.trailingBaselineRatio).toBe(0.85);
		expect(RAMP_GATE_SAMPLE_FLOORS.engagementTrailing).toBe(2000);
	});

	/**
	 * THE 7-DAY WINDOW, pinned the only way it can be today.
	 *
	 * The window itself is a CALLER PARAMETER (`trailingBaselineGates.ts` says
	 * why: inventing a constant with no consumer is the speculative seam D20
	 * forbids), so nothing here can assert its width. What IS assertable is that
	 * the two age allowances ADMIT the intended shape as a pair: a 7-day recent
	 * window whose newest observation is a day old is fresh under the concurrent
	 * rule, while its DISJOINT prior 30-day baseline — which by contract ends
	 * where the recent window begins, so its newest observation is 7 days old — is
	 * fresh under the wider baseline rule. A change to either allowance that made
	 * the intended window shape undecidable fails here.
	 */
	it('the two age allowances admit a 7-day window over a disjoint 30-day baseline', () => {
		const result = evaluateTrailingEngagementGate(
			engagementInput({
				own: arm({ sent: 10_000, calibrationSent: 10_000, calibrationOpened: 2_000 }),
				ownRecent: arm(
					{ sent: 10_000, calibrationSent: 10_000, calibrationOpened: 2_000 },
					// Newest observation in the 7-day window: yesterday.
					{ lastRecordedAt: NOW - DAY_MS }
				),
				ownPriorBaseline: arm(
					{ sent: 10_000, calibrationSent: 10_000, calibrationOpened: 2_000 },
					// Newest observation in `[now - 30d, now - 7d)`: a week ago.
					{ lastRecordedAt: NOW - 7 * DAY_MS }
				),
			})
		);
		expect(result.status).toBe('pass');
		expect(RAMP_GATE_THRESHOLDS.maxEvidenceAgeMs).toBeGreaterThan(DAY_MS);
		expect(RAMP_GATE_THRESHOLDS.maxBaselineAgeMs).toBeGreaterThan(30 * DAY_MS);
	});

	it('a ratio of EXACTLY 0.85 passes — the floor is inclusive', () => {
		// 0.17 / 0.2 = 0.85 exactly, so this case decides the operator rather than a
		// rounding artefact.
		const result = engagement(1_700, 10_000, 2_000);
		expect(result.measurement.ownRate).toBe(0.17);
		expect(result.measurement.referenceRate).toBe(0.2);
		expect(result.status).toBe('pass');
	});

	it('engagement flat against the trailing baseline passes', () => {
		const result = engagement(2_000, 10_000, 2_000);
		expect(result.status).toBe('pass');
	});

	it('a small dip stays inside the widened 0.85 floor', () => {
		// 0.171 / 0.2 = 0.855
		const result = engagement(1_710, 10_000, 2_000);
		expect(result.status).toBe('pass');
	});

	it('a large dip breaches the trailing baseline', () => {
		// 0.169 / 0.2 = 0.845
		const result = engagement(1_690, 10_000, 2_000);
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('trailing_baseline_breached');
	});

	it('a recent window under 2000 calibration sends HOLDS — the floor is enforced, not advisory', () => {
		const result = engagement(300, 1_999, 2_000);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_sample_below_floor');
		expect(result.measurement.minSample).toBe(2_000);
	});

	it('a baseline under 2000 calibration sends HOLDS against the baseline vocabulary', () => {
		const result = evaluateTrailingEngagementGate(
			engagementInput({
				own: arm({ sent: 10_000, calibrationSent: 10_000, calibrationOpened: 2_000 }),
				ownRecent: arm({ sent: 10_000, calibrationSent: 10_000, calibrationOpened: 2_000 }),
				ownPriorBaseline: arm({
					sent: 1_999,
					calibrationSent: 1_999,
					calibrationOpened: 400,
				}),
			})
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('baseline_sample_below_floor');
	});

	it('a baseline at exactly zero engagement HOLDS rather than passing on a divide by zero', () => {
		const result = engagement(2_000, 10_000, 0);
		expect(result.status).toBe('insufficient_data');
	});

	it('an absent baseline HOLDS — never a fail (plan D2)', () => {
		const result = evaluateTrailingEngagementGate(
			engagementInput({
				own: arm({ sent: 10_000, calibrationSent: 10_000, calibrationOpened: 2_000 }),
				ownRecent: arm({ sent: 10_000, calibrationSent: 10_000, calibrationOpened: 2_000 }),
			})
		);
		expect(result.status).toBe('insufficient_data');
	});
});

// ============================ gate 5 — placement ============================

describe('gate 5 — self-hosted seed placement, absolute floor only', () => {
	it('a clean sweep passes with NO reference sweep to compare against', () => {
		const result = evaluateStandaloneSeedPlacementGate(
			input({ own: arm({ sent: 10_000 }), ownSeeds: seeds(19, 1) })
		);
		expect(result.status).toBe('pass');
		expect(result.measurement.referenceSample).toBeNull();
	});

	it('a collapse into spam fails on the absolute floor', () => {
		const result = evaluateStandaloneSeedPlacementGate(
			input({ own: arm({ sent: 10_000 }), ownSeeds: seeds(4, 16) })
		);
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('absolute_threshold_breached');
	});

	// `category` is REACHED and `deleted` is not (`isSeedPlacementReached`), and
	// the gate reads both from the sweep rather than folding them into a spelling
	// it recognises: a gate that dropped `category` would read the first sweep as
	// a 10% collapse, and one that dropped `deleted` would read the second as a
	// clean 100%.
	it('a Gmail tab is reached — a tabbed sweep clears the absolute floor', () => {
		const result = evaluateStandaloneSeedPlacementGate(
			input({ own: arm({ sent: 10_000 }), ownSeeds: seeds(0, 2, 0, { category: 18 }) })
		);
		expect(result.status).toBe('pass');
		expect(result.measurement.ownSample).toBe(20);
		expect(result.measurement.ownRate).toBeCloseTo(0.9, 10);
	});

	it('an auto-deleted probe is counted and is NOT reached', () => {
		const result = evaluateStandaloneSeedPlacementGate(
			input({ own: arm({ sent: 10_000 }), ownSeeds: seeds(17, 0, 0, { deleted: 3 }) })
		);
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('absolute_threshold_breached');
		expect(result.measurement.ownSample).toBe(20);
		expect(result.measurement.ownRate).toBeCloseTo(0.85, 10);
	});

	it('no seed mailboxes at all HOLDS and never fails (plan D2)', () => {
		const result = evaluateStandaloneSeedPlacementGate(input({ own: arm({ sent: 10_000 }) }));
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('evidence_absent');
	});
});
