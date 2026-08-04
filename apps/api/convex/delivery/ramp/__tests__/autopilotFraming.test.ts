/**
 * WITH NO RELAY THE FEATURE IS WARM-UP AUTOPILOT (plan D14).
 *
 * Same screens, same cells, same audit trail — but the headline is CURRENT DAILY
 * CAPACITY AND WHAT IS HOLDING IT BACK, not a percentage. "100% of sending is on
 * your own server" is true on day one of a standalone warm-up and tells the
 * operator nothing about the only number that matters to them.
 */

import { describe, expect, it } from 'vitest';
import { resolveRampDegradation } from '../degradation';
import { RAMP_FULLY_EQUIPPED, RAMP_FULLY_STANDALONE } from '../degradationMatrix';
import { rampHeadline, resolveRampFraming } from '../rampFraming';

const CAPACITY = { dailyCapacity: 2400, blocker: 'the day-9 warm-up step', ownShare: 1 };

describe('the framing follows the actuator, which follows the table', () => {
	it('is Warm-up Autopilot when the substitution table selects the pace actuator', () => {
		const degradation = resolveRampDegradation({
			presence: RAMP_FULLY_STANDALONE,
			provider: 'gmail',
		});
		expect(degradation.actuator).toBe('pace');
		const framing = resolveRampFraming({ actuator: degradation.actuator });
		expect(framing.id).toBe('warmup_autopilot');
		expect(framing.featureName).toBe('Warm-up Autopilot');
		expect(framing.headlineKind).toBe('capacity_and_blocker');
	});

	it('is Sending Independence when a reference transport is present', () => {
		const degradation = resolveRampDegradation({
			presence: RAMP_FULLY_EQUIPPED,
			provider: 'gmail',
		});
		const framing = resolveRampFraming({ actuator: degradation.actuator });
		expect(framing.id).toBe('sending_independence');
		expect(framing.headlineKind).toBe('own_share_percentage');
	});
});

describe('the autopilot headline is capacity and blocker, never a percentage', () => {
	const framing = resolveRampFraming({ actuator: 'pace' });

	it('states the capacity and what is holding it back', () => {
		const headline = rampHeadline(framing, CAPACITY);
		expect(headline).toContain('2400 emails a day');
		expect(headline).toContain('the day-9 warm-up step');
	});

	it('states the capacity alone when nothing is holding it back', () => {
		expect(rampHeadline(framing, { ...CAPACITY, blocker: null })).toBe('2400 emails a day');
	});

	it('never renders a per-cent sign — not even a true one', () => {
		expect(rampHeadline(framing, CAPACITY)).not.toContain('%');
		expect(rampHeadline(framing, { ...CAPACITY, ownShare: 1 })).not.toContain('%');
		expect(rampHeadline(framing, { ...CAPACITY, ownShare: 0.5 })).not.toContain('%');
	});

	it('is degenerate-input safe', () => {
		expect(rampHeadline(framing, { ...CAPACITY, dailyCapacity: Number.NaN })).toContain(
			'0 emails a day'
		);
		expect(rampHeadline(framing, { ...CAPACITY, dailyCapacity: -5 })).toContain('0 emails a day');
	});
});

describe('the equipped headline is the share', () => {
	const framing = resolveRampFraming({ actuator: 'share' });

	it('states the percentage on your own server', () => {
		expect(rampHeadline(framing, { ...CAPACITY, ownShare: 0.7 })).toBe(
			'70% of sending is on your own server'
		);
	});

	it('clamps a degenerate share rather than rendering it', () => {
		expect(rampHeadline(framing, { ...CAPACITY, ownShare: Number.NaN })).toBe(
			'0% of sending is on your own server'
		);
		expect(rampHeadline(framing, { ...CAPACITY, ownShare: 4 })).toBe(
			'100% of sending is on your own server'
		);
	});
});
