/**
 * GATE 2's HARD STOP: per-ISP BLOCK-MESSAGE DETECTION.
 *
 * Standalone mode leans hardest on what receivers say in their own 4xx/5xx text,
 * because with no reference arm and no third-party placement API it is the
 * primary fast signal there is. This suite pins the half of that contract the
 * ramp owns: given the categories the shipped classifier assigns to REAL response
 * shapes, does the gate halt on the ones that mean "we are refusing this sender"
 * and stay quiet on the ones that mean "slow down"?
 *
 * THE FIXTURES ARE SHARED WITH THE CLASSIFIER (`SMTP_BLOCK_MESSAGE_SAMPLES` in
 * `@owlat/shared/smtpBlockCategories`). The MTA's own suite runs the same strings
 * through `classifySmtpResponse` and asserts the same categories, so the two
 * halves cannot drift apart: a regex change there fails there, and a vocabulary
 * change here fails here.
 */

import {
	SMTP_BLOCK_CATEGORIES,
	SMTP_BLOCK_MESSAGE_SAMPLES,
	isSmtpBlockCategory,
} from '@owlat/shared/smtpBlockCategories';
import { describe, expect, it } from 'vitest';
import { RAMP_GATE_SAMPLE_FLOORS, RAMP_GATE_THRESHOLDS } from '../gateConfig';
import {
	evaluateSmtpBlockMessages,
	evaluateStandaloneDeferralGate,
} from '../trailingBaselineGates';
import { NOW, arm, blocks, input, standaloneInput } from './gateFixtures';

const HOUR_MS = 60 * 60 * 1000;

const BLOCK_SAMPLES = SMTP_BLOCK_MESSAGE_SAMPLES.filter((sample) => sample.isBlock);
const PRESSURE_SAMPLES = SMTP_BLOCK_MESSAGE_SAMPLES.filter((sample) => !sample.isBlock);

describe('the block vocabulary', () => {
	it('separates refusal from rate pressure', () => {
		expect(BLOCK_SAMPLES.length).toBeGreaterThan(0);
		expect(PRESSURE_SAMPLES.length).toBeGreaterThan(0);
		for (const sample of BLOCK_SAMPLES) expect(isSmtpBlockCategory(sample.category)).toBe(true);
		for (const sample of PRESSURE_SAMPLES) expect(isSmtpBlockCategory(sample.category)).toBe(false);
	});

	it('never treats throttling as a block — throttling is already the deferral rate', () => {
		for (const throttle of ['rate_limited', 'greylisted', 'gmail_rate_limited', 'yahoo_ts03']) {
			expect(SMTP_BLOCK_CATEGORIES.has(throttle as never)).toBe(false);
		}
	});
});

describe.each(BLOCK_SAMPLES)('a block message ($category) halts the cell', (sample) => {
	it(`halts on: ${sample.response.slice(0, 48)}…`, () => {
		const evaluation = evaluateStandaloneDeferralGate(
			standaloneInput({
				smtpBlocks: blocks(5, 200, { categories: [sample.category] }),
			})
		);
		expect(evaluation.status).toBe('halt');
		expect(evaluation.reason).toBe('block_message_detected');
		expect(evaluation.confidence).toBe('high');
	});
});

describe.each(PRESSURE_SAMPLES)('rate pressure ($category) does not halt', (sample) => {
	it(`stays on the deferral rate for: ${sample.response.slice(0, 48)}…`, () => {
		const evaluation = evaluateStandaloneDeferralGate(
			standaloneInput({
				smtpBlocks: blocks(200, 200, { categories: [sample.category] }),
			})
		);
		expect(evaluation.status).not.toBe('halt');
	});
});

describe('the hard stop is guarded like every other verdict', () => {
	it('does not fire below the minimum classified-response sample (plan D10)', () => {
		const observed = RAMP_GATE_SAMPLE_FLOORS.smtpBlock - 1;
		const evaluation = evaluateStandaloneDeferralGate(
			standaloneInput({ smtpBlocks: blocks(observed, observed) })
		);
		expect(evaluation.status).not.toBe('halt');
	});

	it('fires at the minimum sample', () => {
		const observed = RAMP_GATE_SAMPLE_FLOORS.smtpBlock;
		const evaluation = evaluateStandaloneDeferralGate(
			standaloneInput({ smtpBlocks: blocks(observed, observed) })
		);
		expect(evaluation.status).toBe('halt');
	});

	it('does not fire on a stale observation', () => {
		const evaluation = evaluateStandaloneDeferralGate(
			standaloneInput({ smtpBlocks: blocks(50, 200, { observedAt: NOW - 72 * HOUR_MS }) })
		);
		expect(evaluation.status).not.toBe('halt');
	});

	it('does not fire on a future-dated observation (clock skew is not evidence)', () => {
		const evaluation = evaluateStandaloneDeferralGate(
			standaloneInput({ smtpBlocks: blocks(50, 200, { observedAt: NOW + 72 * HOUR_MS }) })
		);
		expect(evaluation.status).not.toBe('halt');
	});

	it('does not fire below the block-rate threshold', () => {
		// 0.4% of classified responses: under the 0.5% line.
		const evaluation = evaluateStandaloneDeferralGate(
			standaloneInput({ smtpBlocks: blocks(4, 1_000) })
		);
		expect(evaluation.status).not.toBe('halt');
		expect(RAMP_GATE_THRESHOLDS.smtpBlockHalt).toBe(0.005);
	});

	it('fires at the threshold', () => {
		const evaluation = evaluateStandaloneDeferralGate(
			standaloneInput({ smtpBlocks: blocks(5, 1_000) })
		);
		expect(evaluation.status).toBe('halt');
	});

	it('counts without a blocking category do not halt — the categories say WHAT', () => {
		const evaluation = evaluateStandaloneDeferralGate(
			standaloneInput({ smtpBlocks: blocks(200, 200, { categories: ['rate_limited'] }) })
		);
		expect(evaluation.status).not.toBe('halt');
	});

	it('a zero denominator is not a division by zero', () => {
		expect(() =>
			evaluateStandaloneDeferralGate(standaloneInput({ smtpBlocks: blocks(0, 0) }))
		).not.toThrow();
	});

	it('absent block data changes nothing: the deferral rate still decides', () => {
		const evaluation = evaluateStandaloneDeferralGate(standaloneInput());
		expect(evaluation.status).toBe('pass');
		expect(evaluateSmtpBlockMessages(standaloneInput())).toBeNull();
	});
});

describe('the block stop outranks the rate check', () => {
	it('halts with the block reason even when the deferral rate is perfectly healthy', () => {
		const evaluation = evaluateStandaloneDeferralGate(
			standaloneInput({
				own: arm({ sent: 10_000, deferred: 10 }),
				smtpBlocks: blocks(50, 200),
			})
		);
		expect(evaluation.status).toBe('halt');
		expect(evaluation.reason).toBe('block_message_detected');
	});

	it('a deferral-rate halt keeps its own reason when there are no block messages', () => {
		const evaluation = evaluateStandaloneDeferralGate(
			input({ own: arm({ sent: 10_000, deferred: 4_000 }) })
		);
		expect(evaluation.status).toBe('halt');
		expect(evaluation.reason).toBe('halt_threshold_breached');
	});
});
