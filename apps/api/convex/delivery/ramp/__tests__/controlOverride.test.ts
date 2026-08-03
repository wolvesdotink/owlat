/**
 * THE OPERATOR OVERRIDE, EXHAUSTIVELY — and the property the whole design rests
 * on: a control can never hold a RETREAT.
 *
 * The rest is bookkeeping; this is the safety argument. A gate breach, an open
 * breaker, a critical blocklist listing and a capacity ceiling all still take
 * the share down through a pause and through a pin, because a safety response an
 * operator can switch off is not a safety response.
 *
 * PURE, so the fixtures can be hostile: a NaN pin, a pin above 1, a pin below 0,
 * a pause on a cell that was not moving anyway.
 */

import { describe, expect, it } from 'vitest';
import {
	applyPaceCellControl,
	applyRampCellControl,
	type RampCellControl,
} from '../controlOverride';
import { paceDecisionChangedState, type PaceDecision } from '../paceTypes';
import { defaultRampPreset } from '@owlat/shared/deliverabilityIndependence';
import { rampConfigForStream } from '../presetConfig';
import { RAMP_STREAM_CONFIGS } from '../gateConfig';
import type { RampDecision } from '../controllerTypes';

const NOW = Date.UTC(2026, 6, 20);

function decision(overrides: Partial<RampDecision> = {}): RampDecision {
	return {
		share: 0.3,
		fromShare: 0.25,
		reason: 'healthy',
		direction: 'increase',
		verdict: 'pass',
		failedGate: undefined,
		freeze: undefined,
		cleanStreak: 3,
		phaseCeiling: 0.5,
		greenSince: undefined,
		graduatedAt: undefined,
		pinChange: undefined,
		countedAt: NOW,
		ceiling: 0.5,
		// P3-8 folds the substitution table into the decision; a fixture that
		// omits it is not a RampDecision.
		cappedBy: undefined,
		...overrides,
	};
}

const RUNNING: RampCellControl = { pausedAt: undefined, pinnedShare: undefined };

describe('no control can hold a retreat', () => {
	const retreat = decision({
		share: 0.125,
		fromShare: 0.25,
		direction: 'decrease',
		reason: 'hard_bounce',
		failedGate: 'hard_bounce',
		verdict: 'fail',
		freeze: { until: NOW + 6 * 3_600_000, origin: 'gate_breach', ladderMs: 6 * 3_600_000 },
	});

	it('applies the retreat through a pause', () => {
		expect(applyRampCellControl(retreat, { pausedAt: NOW, pinnedShare: undefined })).toBe(retreat);
	});

	it('applies the retreat through a pin ABOVE the retreat target', () => {
		expect(applyRampCellControl(retreat, { pausedAt: undefined, pinnedShare: 0.9 })).toBe(retreat);
	});

	it('applies the retreat through both at once, freeze and streak intact', () => {
		const result = applyRampCellControl(retreat, { pausedAt: NOW, pinnedShare: 0.2 });
		expect(result.share).toBe(0.125);
		expect(result.freeze?.ladderMs).toBe(6 * 3_600_000);
		expect(result.cleanStreak).toBe(3);
	});
});

describe('pause', () => {
	it('holds an increase at the current share and names the operator', () => {
		const result = applyRampCellControl(decision(), { pausedAt: NOW, pinnedShare: undefined });
		expect(result.share).toBe(0.25);
		expect(result.direction).toBe('hold');
		expect(result.reason).toBe('operator_pause');
		expect(result.ceiling).toBe(0.25);
	});

	it('leaves an ordinary hold alone rather than claiming credit for it', () => {
		const holding = decision({ share: 0.25, direction: 'hold', reason: 'building_confidence' });
		expect(applyRampCellControl(holding, { pausedAt: NOW, pinnedShare: undefined })).toBe(holding);
	});

	it('beats a pin when both are set — the stronger statement wins', () => {
		const result = applyRampCellControl(decision(), { pausedAt: NOW, pinnedShare: 0.28 });
		expect(result.reason).toBe('operator_pause');
		expect(result.share).toBe(0.25);
	});

	it('never rewrites the freeze, the streak or the graduation pin', () => {
		const graduated = decision({
			share: 0.4,
			fromShare: 0.3,
			graduatedAt: NOW - 1000,
			cleanStreak: 9,
		});
		const result = applyRampCellControl(graduated, { pausedAt: NOW, pinnedShare: undefined });
		expect(result.graduatedAt).toBe(NOW - 1000);
		expect(result.cleanStreak).toBe(9);
	});
});

describe('pin', () => {
	it('caps an increase at the pinned share', () => {
		const result = applyRampCellControl(decision({ share: 0.6, fromShare: 0.3 }), {
			pausedAt: undefined,
			pinnedShare: 0.4,
		});
		expect(result.share).toBe(0.4);
		expect(result.direction).toBe('increase');
		expect(result.reason).toBe('operator_pin');
		expect(result.ceiling).toBe(0.4);
	});

	it('does not touch an increase that already fits under the pin', () => {
		const under = decision({ share: 0.3, fromShare: 0.25 });
		expect(applyRampCellControl(under, { pausedAt: undefined, pinnedShare: 0.5 })).toBe(under);
	});

	it('never pulls a cell DOWN to the pin — only a gate may lower a share', () => {
		const climbing = decision({ share: 0.8, fromShare: 0.7 });
		const result = applyRampCellControl(climbing, {
			pausedAt: undefined,
			pinnedShare: 0.2,
		});
		expect(result.share).toBe(0.7);
		expect(result.direction).toBe('hold');
		// AND THE PIN OWNS THE REASON, because the pin is what stopped the climb.
		expect(result.reason).toBe('operator_pin');
		// The pin did NOT bound the share it ended up at, so it must not narrow the
		// recorded ceiling either: an evidence row saying "share 0.7, ceiling 0.2"
		// contradicts itself for anyone replaying the decision.
		expect(result.ceiling).toBe(climbing.ceiling);
	});

	it('leaves an ordinary HOLD reporting its real binding constraint, not the pin', () => {
		// A pin stored BELOW the cell's share suppressed nothing on a hold, and a
		// grid column headed "Holding it back" must name the constraint that is
		// actually binding rather than the operator who set an unrelated cap.
		for (const reason of ['frozen', 'evidence_stale', 'building_confidence'] as const) {
			const held = decision({ share: 0.7, fromShare: 0.7, reason, direction: 'hold' });
			const result = applyRampCellControl(held, { pausedAt: undefined, pinnedShare: 0.2 });
			expect(result).toBe(held);
			expect(result.reason).toBe(reason);
		}
	});

	it('reads a hostile stored pin without producing a hostile share', () => {
		for (const pinned of [Number.NaN, Number.POSITIVE_INFINITY, -5, 42]) {
			const result = applyRampCellControl(decision({ share: 0.6, fromShare: 0.3 }), {
				pausedAt: undefined,
				pinnedShare: pinned,
			});
			expect(Number.isFinite(result.share)).toBe(true);
			expect(result.share).toBeGreaterThanOrEqual(0);
			expect(result.share).toBeLessThanOrEqual(1);
		}
	});

	it('is a no-op on a running, unpinned cell', () => {
		const untouched = decision();
		expect(applyRampCellControl(untouched, RUNNING)).toBe(untouched);
	});
});

describe('presets', () => {
	it('balanced is byte-for-byte the shipped configuration', () => {
		for (const stream of ['campaign', 'automation', 'transactional'] as const) {
			const tuned = rampConfigForStream(stream, { [stream]: 'balanced' }, 'balanced');
			expect(tuned.increaseStep).toBe(RAMP_STREAM_CONFIGS[stream].increaseStep);
			expect(tuned.cleanWindowsRequired).toBe(RAMP_STREAM_CONFIGS[stream].cleanWindowsRequired);
		}
	});

	it('conservative asks for smaller steps and more evidence', () => {
		const tuned = rampConfigForStream('campaign', { campaign: 'conservative' }, 'balanced');
		expect(tuned.increaseStep).toBeLessThan(RAMP_STREAM_CONFIGS.campaign.increaseStep);
		expect(tuned.cleanWindowsRequired).toBeGreaterThan(
			RAMP_STREAM_CONFIGS.campaign.cleanWindowsRequired
		);
	});

	it('aggressive raises the step and never the tolerance or the floors', () => {
		const tuned = rampConfigForStream('campaign', { campaign: 'aggressive' }, 'balanced');
		expect(tuned.increaseStep).toBeGreaterThan(RAMP_STREAM_CONFIGS.campaign.increaseStep);
		expect(tuned.thresholds).toBe(RAMP_STREAM_CONFIGS.campaign.thresholds);
		expect(tuned.sampleFloors).toBe(RAMP_STREAM_CONFIGS.campaign.sampleFloors);
	});

	it('falls back to the deployment default for a stream nobody chose one for', () => {
		const tuned = rampConfigForStream('automation', {}, 'conservative');
		expect(tuned.increaseStep).toBeLessThan(RAMP_STREAM_CONFIGS.automation.increaseStep);
	});

	/**
	 * THE STANDALONE DEPLOYMENT'S EXACT CONSTANTS, PINNED.
	 *
	 * `conservative` is not merely "slower" — it IS the plan's standalone
	 * substitution (K_CLEAN 3 -> 5, step halved), and it is applied in exactly one
	 * place so it cannot compound. These are the numbers, by name, so neither the
	 * tuning nor the default can drift without this failing.
	 */
	it('pins the exact constants a standalone deployment runs under', () => {
		const campaign = rampConfigForStream('campaign', {}, defaultRampPreset(false));
		const automation = rampConfigForStream('automation', {}, defaultRampPreset(false));
		const transactional = rampConfigForStream('transactional', {}, defaultRampPreset(false));
		expect(defaultRampPreset(false)).toBe('conservative');
		expect(campaign.increaseStep).toBe(2.5);
		expect(automation.increaseStep).toBe(2.5);
		expect(transactional.increaseStep).toBe(1.5);
		for (const config of [campaign, automation, transactional]) {
			expect(config.cleanWindowsRequired).toBe(5);
		}
	});

	it('a deployment WITH a relay runs the shipped constants exactly', () => {
		expect(defaultRampPreset(true)).toBe('balanced');
		for (const stream of ['campaign', 'automation', 'transactional'] as const) {
			const tuned = rampConfigForStream(stream, {}, defaultRampPreset(true));
			expect(tuned.increaseStep).toBe(RAMP_STREAM_CONFIGS[stream].increaseStep);
			expect(tuned.cleanWindowsRequired).toBe(RAMP_STREAM_CONFIGS[stream].cleanWindowsRequired);
		}
	});

	it('never asks for a fractional number of clean windows', () => {
		for (const preset of ['conservative', 'balanced', 'aggressive'] as const) {
			const tuned = rampConfigForStream('campaign', { campaign: preset }, 'balanced');
			expect(Number.isInteger(tuned.cleanWindowsRequired)).toBe(true);
		}
	});
});

/**
 * THE SAME HAND ON THE SECOND DIAL (plan D3, P3-6).
 *
 * `setCellPause` succeeds on every managed cell, and until this existed the
 * override only reached the SHARE — so on a pace-actuated cell (a deployment with
 * no reference transport, the configuration the standalone twin exists for) the
 * warming multiplier went on taking its daily step while the control reported
 * that the increase was held. The rule is the share's, unchanged: suppress
 * INCREASES, never a retreat, and never rewrite measurement state.
 */
describe('the operator override on the pace dial', () => {
	function pace(overrides: Partial<PaceDecision> = {}): PaceDecision {
		return {
			multiplier: 1.2,
			fromMultiplier: 1.1,
			reason: 'healthy',
			direction: 'increase',
			verdict: 'pass',
			failedGate: undefined,
			freeze: undefined,
			cleanStreak: 3,
			countedUtcDay: '2026-07-20',
			...overrides,
		};
	}

	const PAUSED: RampCellControl = { pausedAt: NOW, pinnedShare: undefined };

	it('holds an increase at the current multiplier and names the operator', () => {
		const result = applyPaceCellControl(pace(), PAUSED);
		expect(result.multiplier).toBe(1.1);
		expect(result.direction).toBe('hold');
		expect(result.reason).toBe('operator_pause');
	});

	// THE SAFETY ARGUMENT, on the dial that cannot be taken back: a warming cap
	// that grew too fast is not undone by lowering it again, so a retreat here
	// matters more than on the share and is even less overridable.
	it('never holds a retreat, freeze and ladder rung intact', () => {
		const retreat = pace({
			multiplier: 0.55,
			fromMultiplier: 1.1,
			direction: 'decrease',
			reason: 'complaint',
			verdict: 'fail',
			failedGate: 'complaint',
			freeze: { until: NOW + 6 * 3_600_000, origin: 'gate_breach', ladderMs: 6 * 3_600_000 },
		});
		const result = applyPaceCellControl(retreat, PAUSED);
		expect(result).toBe(retreat);
		expect(result.freeze?.ladderMs).toBe(6 * 3_600_000);
	});

	it('leaves an ordinary hold reporting the constraint that is really binding', () => {
		for (const reason of ['frozen', 'low_utilisation', 'building_confidence'] as const) {
			const held = pace({ multiplier: 1.1, direction: 'hold', reason });
			expect(applyPaceCellControl(held, PAUSED)).toBe(held);
		}
	});

	// The suppressed step's window WAS measured; the operator's hand did not make
	// it unmeasured. Leaving the counted day alone is also what keeps the other
	// twenty-three ticks of the day reporting `day_already_advanced` instead of
	// relabelling every one of them `operator_pause`.
	it('never rewrites the streak, the freeze or the counted day', () => {
		const result = applyPaceCellControl(pace({ cleanStreak: 9 }), PAUSED);
		expect(result.cleanStreak).toBe(9);
		expect(result.countedUtcDay).toBe('2026-07-20');
	});

	// A PIN IS A SHARE. There is no honest conversion into a multiplier on a daily
	// cap, so it governs nothing here — and the mutation's audit row says so
	// rather than promising a cap it cannot apply.
	it('ignores a pin, whatever it says', () => {
		const untouched = pace();
		expect(applyPaceCellControl(untouched, { pausedAt: undefined, pinnedShare: 0.2 })).toBe(
			untouched
		);
	});

	it('is a no-op on a running cell', () => {
		const untouched = pace();
		expect(applyPaceCellControl(untouched, RUNNING)).toBe(untouched);
	});
});

/**
 * DID THE PACE DIAL CHANGE ANYTHING DURABLE? The predicate the cron audits off,
 * pinned here rather than spelled inline in the shell where it would be a rule
 * with no fixture behind it.
 */
describe('paceDecisionChangedState', () => {
	function held(overrides: Partial<PaceDecision> = {}): PaceDecision {
		return {
			multiplier: 1.1,
			fromMultiplier: 1.1,
			reason: 'holding',
			direction: 'hold',
			verdict: 'pass',
			failedGate: undefined,
			freeze: undefined,
			cleanStreak: 3,
			countedUtcDay: undefined,
			...overrides,
		};
	}

	it('is true when the dial moved', () => {
		expect(paceDecisionChangedState(held({ multiplier: 1.2, direction: 'increase' }))).toBe(true);
		expect(paceDecisionChangedState(held({ multiplier: 0.55, direction: 'decrease' }))).toBe(true);
	});

	// A BREACH ON A CELL ALREADY AT M_MIN moves no multiplier and still advances
	// the ladder, re-dates the freeze and resets the streak. An operator cannot
	// explain an automatic change no log records.
	it('is true for a gate breach that advanced the ladder without moving the dial', () => {
		expect(
			paceDecisionChangedState(
				held({
					reason: 'complaint',
					freeze: { until: NOW + 6 * 3_600_000, origin: 'gate_breach', ladderMs: 6 * 3_600_000 },
				})
			)
		).toBe(true);
	});

	// A hard stop that is merely STILL TRUE an hour later re-stamps a freeze and
	// claims no rung: nothing happened, and it stays out of the log.
	it('is false for a hold, and for a re-stamped hard stop that claims no rung', () => {
		expect(paceDecisionChangedState(held())).toBe(false);
		expect(
			paceDecisionChangedState(
				held({ reason: 'dnsbl', freeze: { until: NOW + 24 * 3_600_000, origin: 'dnsbl' } })
			)
		).toBe(false);
	});
});
