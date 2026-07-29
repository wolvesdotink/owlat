/**
 * ONE FACT MAY SLOW A CELL ONCE (plan D3, D9, D14).
 *
 * The operator's aggressiveness preset (P3-6) and the substitution table (P3-8)
 * both transform the same per-stream constants, and for a while both of them
 * answered "this deployment has no reference transport" with the same slowdown:
 * the preset fell back to `conservative` (step x0.5, +2 clean windows) and the
 * table applied `stepMultiplier: 0.5` on top. The clean-window count did not
 * double-count — the table writes an absolute override — but the STEP did, so a
 * standalone campaign cell advanced at a QUARTER of its shipped step where the
 * plan says half. Half the ramp speed, from two modules each behaving exactly as
 * designed.
 *
 * The division of labour these cases pin: the TABLE owns what an ABSENT
 * INTEGRATION costs, and a PRESET owns what an OPERATOR CHOSE. An explicit
 * `conservative` still stacks — that is an instruction, not an inference drawn
 * twice.
 */

import { describe, expect, it } from 'vitest';
import { rampConfigForStream } from '../presetConfig';
import { degradedStreamConfig, resolveRampDegradation } from '../degradation';
import { RAMP_STREAM_CONFIGS } from '../gateConfig';

const EQUIPPED = {
	reference_transport: true,
	google_postmaster: true,
	microsoft_snds: true,
	complaint_feedback_loop: true,
	seed_mailboxes: true,
	commercial_placement_api: true,
} as const;

const STANDALONE = { ...EQUIPPED, reference_transport: false } as const;

/** The controller's own composition: preset first, table last. */
function composed(presence: typeof EQUIPPED, preset: 'conservative' | 'balanced' | 'aggressive') {
	const degradation = resolveRampDegradation({ presence, provider: 'gmail' });
	return degradedStreamConfig(rampConfigForStream('campaign', {}, preset), degradation);
}

describe('an absent reference transport slows the ramp exactly once', () => {
	const shipped = RAMP_STREAM_CONFIGS.campaign;

	it('halves the step on a standalone deployment — never quarters it', () => {
		const config = composed(STANDALONE, 'balanced');
		expect(config.increaseStep as number).toBeCloseTo((shipped.increaseStep as number) / 2, 10);
		// The table's absolute override, not the shipped 3 plus the preset's 2.
		expect(config.cleanWindowsRequired).toBe(5);
	});

	it('leaves an equipped deployment on the shipped constants', () => {
		const config = composed(EQUIPPED, 'balanced');
		expect(config.increaseStep as number).toBeCloseTo(shipped.increaseStep as number, 10);
		expect(config.cleanWindowsRequired).toBe(shipped.cleanWindowsRequired);
	});

	it('still honours a preset the operator chose ON TOP of the table', () => {
		// Deliberate stacking: the operator asked for caution the table had not
		// already inferred, so this quarter-step IS the instruction.
		const config = composed(STANDALONE, 'conservative');
		expect(config.increaseStep as number).toBeCloseTo((shipped.increaseStep as number) / 4, 10);
	});

	it('an aggressive preset cannot out-argue the table on an absent integration', () => {
		// The preset scales the step UP, then the table halves whatever it is
		// handed — so the safety substitution is still paid. Composition order is
		// what guarantees it (preset first, table last).
		const aggressive = composed(STANDALONE, 'aggressive');
		const balanced = composed(STANDALONE, 'balanced');
		expect(aggressive.increaseStep as number).toBeGreaterThan(balanced.increaseStep as number);
		expect(aggressive.increaseStep as number).toBeLessThan(
			(rampConfigForStream('campaign', {}, 'aggressive').increaseStep as number) + 1e-9
		);
		expect(aggressive.cleanWindowsRequired).toBe(5);
	});
});
