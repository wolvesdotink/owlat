/**
 * GATE 2's HARD STOP: per-ISP BLOCK-MESSAGE DETECTION.
 *
 * Standalone mode is MEANT to lean hardest on what receivers say in their own
 * 4xx/5xx text, because with no reference arm and no third-party placement API it
 * is the fastest signal available to it. This suite pins the half of that
 * contract the ramp owns: given the categories the shipped classifier assigns to
 * REAL response shapes, does the gate halt on the ones that mean "we are refusing
 * this sender" and stay quiet on the ones that mean "slow down"?
 *
 * THE CLAUSE IS LIVE (issue #501). The classification still happens in the MTA,
 * but the category now travels as a typed field on an `smtp.classified` webhook
 * and `analytics/smtpResponseCategories.ts` counts it per (cell, arm, UTC day),
 * so both readers supply `input.smtpBlocks` and this halt can fire in a real
 * deployment.
 *
 * THIS SUITE STILL RUNS AGAINST THE SHARED SAMPLES rather than against a live
 * counter, because what it guards is the agreement between the two halves of the
 * vocabulary and not the liveness of the wire between them — a drift in the
 * category names would be discovered only by the halt silently never firing
 * again, whether the wire is up or not. That the clause is REACHED from a real
 * deployment's rows is the other suite's job
 * (`delivery/__tests__/smtpBlockWiring.test.ts`), and that both readers supply
 * the field at all is `gateInputWiring.test.ts`'.
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
	summarizeSmtpBlocks,
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
				smtpBlocks: blocks(5, 200, { category: sample.category }),
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
				smtpBlocks: blocks(200, 200, { category: sample.category }),
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

	it('a window of pure rate pressure sums to a ZERO numerator, so it cannot halt', () => {
		// Two hundred classified responses, every one of them a throttle. The
		// numerator is derived from the block subset alone, so there is nothing to
		// halt on — the count cannot disagree with the categories because there is
		// only one field.
		const observation = blocks(200, 200, { category: 'rate_limited' });
		expect(summarizeSmtpBlocks(observation).blocked).toBe(0);
		expect(summarizeSmtpBlocks(observation).categories).toEqual([]);
		expect(
			evaluateStandaloneDeferralGate(standaloneInput({ smtpBlocks: observation })).status
		).not.toBe('halt');
	});

	it('sums ONLY the block subset when a window carries both refusals and throttles', () => {
		const observation = {
			observed: 1_000,
			blockedByCategory: {
				content_rejected: 4,
				policy_rejected: 1,
				rate_limited: 800,
				greylisted: 100,
			},
			observedAt: NOW,
		} as const;
		const summary = summarizeSmtpBlocks(observation);
		expect(summary.blocked).toBe(5);
		expect([...summary.categories].sort()).toEqual(['content_rejected', 'policy_rejected']);
		// 5 of 1000 = the halt line exactly; the throttles are carried, never counted.
		expect(
			evaluateStandaloneDeferralGate(standaloneInput({ smtpBlocks: observation })).status
		).toBe('halt');
	});

	it('a zero denominator is not a division by zero', () => {
		expect(() =>
			evaluateStandaloneDeferralGate(standaloneInput({ smtpBlocks: blocks(0, 0) }))
		).not.toThrow();
	});

	it('more blocks than classified responses is UNMEASURABLE, not a 100% block rate', () => {
		// An impossible producer row. A clamp to 1.0 would manufacture the highest
		// possible reading of the one signal here that halts a cell outright, so the
		// row is discarded and the deferral rate behind it decides on its own.
		const built = standaloneInput({
			own: arm({ sent: 10_000, deferred: 10 }),
			smtpBlocks: blocks(500, 200),
		});
		expect(evaluateSmtpBlockMessages(built)).toBeNull();
		expect(evaluateStandaloneDeferralGate(built).status).toBe('pass');
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

/**
 * THE UNIT THE HALT IS DENOMINATED IN (plan D12).
 *
 * Every other `deferral` verdict counts SENDS. This one counts CLASSIFIED SMTP
 * RESPONSES, because the question it answers is "what share of the receiver's
 * answers said it is refusing this sender", which has nothing to do with how many
 * messages were handed over. `ownSample` and `minSample` are a PAIR and are
 * pinned here in the same unit, and `gateTypes.ts` documents that pairing so the
 * renderer branches on the reason instead of printing "N sends".
 */
describe('the halt reports its sample in classified responses, not sends', () => {
	it('pins ownSample to the observed responses and minSample to their floor', () => {
		const built = standaloneInput({
			// Ten thousand SENDS, two hundred classified responses. The two numbers are
			// deliberately far apart: a measurement that reported the send count would
			// be off by fifty times and would still look plausible on screen.
			own: arm({ sent: 10_000, deferred: 200 }),
			smtpBlocks: blocks(50, 200),
		});
		const result = evaluateSmtpBlockMessages(built);
		expect(result).not.toBeNull();
		expect(result?.measurement.ownSample).toBe(200);
		expect(result?.measurement.minSample).toBe(RAMP_GATE_SAMPLE_FLOORS.smtpBlock);
		// The rate is the block SHARE OF THOSE RESPONSES, compared against the halt
		// threshold in the same unit.
		expect(result?.measurement.ownRate).toBeCloseTo(50 / 200, 10);
		expect(result?.measurement.thresholdRate).toBe(RAMP_GATE_THRESHOLDS.smtpBlockHalt as number);
	});
});
