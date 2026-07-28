/**
 * UNITS regression. Assume the author confused percentage points with fractions
 * somewhere and go looking for it.
 *
 * Every threshold is pinned in BOTH readings, and each pinning is paired with a
 * behavioural probe at the value the wrong reading would have accepted:
 *
 *   - 2% read as the fraction 2 would accept every hard-bounce rate there is;
 *   - a 0.5pp tolerance read as the fraction 0.5 would accept a 50-point gap;
 *   - 0.1% read as 0.1 would accept a hundredfold complaint rate;
 *   - a 5pp seed tolerance read as the fraction 5 would accept any collapse.
 *
 * Each of those is a deployment ramping into the spam folder, so each gets a
 * test that fails loudly if the unit ever slips.
 */

import { describe, expect, it } from 'vitest';
import {
	DELIVERABILITY_SNAPSHOT_MAX_FUTURE_SKEW_MS,
	DELIVERABILITY_STREAM_KEYS,
} from '@owlat/shared/deliverabilityRouting';
import {
	percentagePoints,
	ppToFraction,
	RAMP_GATE_THRESHOLDS,
	RAMP_STREAM_CONFIGS,
} from '../gateConfig';
import {
	evaluateComplaintGate,
	evaluateDeferralGate,
	evaluateHardBounceGate,
	evaluateSeedPlacementGate,
} from '../gates';
import { arm, input, seeds } from './gateFixtures';

const STREAM_CONFIGS = DELIVERABILITY_STREAM_KEYS.map((stream) => RAMP_STREAM_CONFIGS[stream]);

describe('the conversion', () => {
	it('turns percentage points into a fraction', () => {
		expect(ppToFraction(percentagePoints(0.5))).toBeCloseTo(0.005, 12);
		expect(ppToFraction(percentagePoints(0.05))).toBeCloseTo(0.0005, 12);
		expect(ppToFraction(percentagePoints(5))).toBeCloseTo(0.05, 12);
		expect(ppToFraction(percentagePoints(100))).toBe(1);
	});
});

describe('every threshold is stored as a FRACTION, never as a percentage', () => {
	it('pins the four rate ceilings', () => {
		expect(RAMP_GATE_THRESHOLDS.hardBounceMax).toBe(0.02);
		expect(RAMP_GATE_THRESHOLDS.deferralMax).toBe(0.1);
		expect(RAMP_GATE_THRESHOLDS.deferralHalt).toBe(0.25);
		expect(RAMP_GATE_THRESHOLDS.complaintMax).toBe(0.001);
		expect(RAMP_GATE_THRESHOLDS.seedInboxMin).toBe(0.9);
		for (const value of [
			RAMP_GATE_THRESHOLDS.hardBounceMax,
			RAMP_GATE_THRESHOLDS.deferralMax,
			RAMP_GATE_THRESHOLDS.deferralHalt,
			RAMP_GATE_THRESHOLDS.complaintMax,
			RAMP_GATE_THRESHOLDS.seedInboxMin,
		]) {
			expect(value).toBeGreaterThan(0);
			expect(value).toBeLessThanOrEqual(1);
		}
	});

	it('reuses the shipped clock-skew allowance rather than inventing a second one', () => {
		expect(RAMP_GATE_THRESHOLDS.maxFutureSkewMs).toBe(DELIVERABILITY_SNAPSHOT_MAX_FUTURE_SKEW_MS);
	});

	it('gives the historical baseline its own age allowance, wider than the concurrent one', () => {
		const DAY_MS = 24 * 60 * 60 * 1000;
		// The concurrent rule: one clean window plus slack.
		expect(RAMP_GATE_THRESHOLDS.maxEvidenceAgeMs).toBe(48 * 60 * 60 * 1000);
		// The baseline's window is `[now - 30d, now - 7d)`, so its allowance must
		// cover the whole width of that window or the slow-poison floor is dead on
		// every input that respects the contract.
		expect(RAMP_GATE_THRESHOLDS.maxBaselineAgeMs).toBeGreaterThan(30 * DAY_MS);
		// …and it must stay a SEPARATE knob: widening the concurrent rule to reach
		// a month would loosen "never increase without fresh evidence" (D9/D10) for
		// every other gate.
		expect(RAMP_GATE_THRESHOLDS.maxBaselineAgeMs).toBeGreaterThan(
			RAMP_GATE_THRESHOLDS.maxEvidenceAgeMs
		);
	});

	it('pins the three tolerances as PERCENTAGE POINTS', () => {
		expect(RAMP_GATE_THRESHOLDS.hardBounceTolerance).toBe(0.5);
		expect(RAMP_GATE_THRESHOLDS.complaintTolerance).toBe(0.05);
		expect(RAMP_GATE_THRESHOLDS.seedInboxTolerance).toBe(5);
	});
});

describe('the wrong reading is rejected behaviourally', () => {
	it('a 5% hard-bounce rate fails — 2% is not the fraction 2', () => {
		const result = evaluateHardBounceGate(
			input({
				own: arm({ sent: 10_000, hardBounced: 500 }),
				reference: arm({ sent: 10_000, hardBounced: 500 }),
			})
		);
		expect(result.status).toBe('fail');
		expect(result.measurement.ownRate).toBeCloseTo(0.05, 12);
	});

	it('an own arm 0.59pp above the reference fails — 0.5pp is not the fraction 0.5', () => {
		const result = evaluateHardBounceGate(
			input({
				own: arm({ sent: 10_000, hardBounced: 60 }), // 0.60%
				reference: arm({ sent: 10_000, hardBounced: 1 }), // 0.01%
			})
		);
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('reference_tolerance_breached');
	});

	it('a 1% complaint rate fails — 0.1% is not the fraction 0.1', () => {
		const result = evaluateComplaintGate(
			input({
				own: arm({ sent: 100_000, complained: 1_000 }),
				reference: arm({ sent: 100_000, complained: 1_000 }),
			})
		);
		expect(result.status).toBe('fail');
		expect(result.measurement.ownRate).toBeCloseTo(0.01, 12);
	});

	it('an own arm 0.06pp above the reference fails — 0.05pp is not the fraction 0.05', () => {
		const result = evaluateComplaintGate(
			input({
				own: arm({ sent: 1_000_000, complained: 700 }), // 0.070%
				reference: arm({ sent: 1_000_000, complained: 90 }), // 0.009%
			})
		);
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('reference_tolerance_breached');
	});

	it('a 15% deferral rate fails — 10% is not the fraction 10', () => {
		const result = evaluateDeferralGate(input({ own: arm({ sent: 10_000, deferred: 1_500 }) }));
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('absolute_threshold_breached');
		expect(result.measurement.ownRate).toBeCloseTo(0.15, 12);
	});

	it('a 30% deferral rate HALTS — 25% is not the fraction 25', () => {
		const result = evaluateDeferralGate(input({ own: arm({ sent: 10_000, deferred: 3_000 }) }));
		expect(result.status).toBe('halt');
		expect(result.reason).toBe('halt_threshold_breached');
		expect(result.measurement.ownRate).toBeCloseTo(0.3, 12);
	});

	it('a seed collapse to 50% inbox fails — 90% is not the fraction 90', () => {
		const result = evaluateSeedPlacementGate(
			input({
				own: arm({ sent: 10_000 }),
				ownSeeds: seeds(10, 10),
				referenceSeeds: seeds(20, 0),
			})
		);
		expect(result.status).toBe('fail');
		expect(result.measurement.ownRate).toBe(0.5);
	});

	it('an own arm 10pp below the reference seeds fails — 5pp is not the fraction 5', () => {
		const result = evaluateSeedPlacementGate(
			input({
				own: arm({ sent: 10_000 }),
				ownSeeds: seeds(90, 10), // 90.0%
				referenceSeeds: seeds(100, 0), // 100.0%
			})
		);
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('reference_tolerance_breached');
	});
});

describe('per-stream ramp constants', () => {
	it('pins the plan’s starting shares and steps', () => {
		expect(RAMP_STREAM_CONFIGS.campaign.initialShareFraction).toBe(0.02);
		expect(RAMP_STREAM_CONFIGS.campaign.increaseStep).toBe(5);
		expect(RAMP_STREAM_CONFIGS.automation.initialShareFraction).toBe(0.05);
		expect(RAMP_STREAM_CONFIGS.automation.increaseStep).toBe(5);
		expect(RAMP_STREAM_CONFIGS.transactional.initialShareFraction).toBe(0);
		expect(RAMP_STREAM_CONFIGS.transactional.increaseStep).toBe(3);
	});

	it('keeps shares as fractions and steps as percentage points', () => {
		for (const config of STREAM_CONFIGS) {
			expect(config.initialShareFraction).toBeGreaterThanOrEqual(0);
			expect(config.initialShareFraction).toBeLessThanOrEqual(1);
			expect(config.increaseStep).toBeGreaterThan(0);
			// A step of 5 POINTS is 0.05 of share — a step stored as a fraction
			// would be <= 1 and would silently ramp 100x too slowly.
			expect(ppToFraction(config.increaseStep)).toBeLessThanOrEqual(0.05);
			expect(config.cleanWindowsRequired).toBe(3);
		}
	});

	it('shares the same safety thresholds across every stream', () => {
		for (const config of STREAM_CONFIGS) {
			expect(config.thresholds).toBe(RAMP_GATE_THRESHOLDS);
		}
	});
});
