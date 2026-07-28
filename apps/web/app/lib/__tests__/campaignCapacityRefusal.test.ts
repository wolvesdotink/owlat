/**
 * The capacity refusal reader: turn the `exceeds_sending_capacity` Operation
 * error into a schedule the UI can render — or `null`, which puts the failure
 * back on the default toast path.
 *
 * The negative cases matter as much as the positive one: a half-recognised
 * payload MUST NOT render a half-empty panel, and no other refusal reason may
 * be captured by this branch.
 */
import { describe, it, expect } from 'vitest';
import type { OperationError } from '@owlat/shared/operationError';

import { capacityRefusalPlan, capacityScheduleHeadline } from '../campaignCapacityRefusal';

function refusal(capacityPlan: unknown): OperationError {
	return {
		category: 'invalid_state',
		message: 'too big',
		data: { reason: 'exceeds_sending_capacity', capacityPlan } as Record<string, unknown>,
	};
}

const VALID_PLAN = {
	fits: false,
	days: 5,
	slices: [0, 100, 200, 200, 100],
	finishesAt: 1_700_000_000_000,
	covered: 600,
	truncated: false,
	audienceUnderCounted: false,
};

describe('capacityRefusalPlan', () => {
	it('reads the schedule off an exceeds_sending_capacity refusal', () => {
		expect(capacityRefusalPlan(refusal(VALID_PLAN))).toEqual({
			days: 5,
			slices: [0, 100, 200, 200, 100],
			finishesAt: 1_700_000_000_000,
			covered: 600,
			truncated: false,
			audienceUnderCounted: false,
		});
	});

	it('carries the truncated and under-counted flags through', () => {
		const plan = capacityRefusalPlan(
			refusal({ ...VALID_PLAN, truncated: true, audienceUnderCounted: true })
		);
		expect(plan?.truncated).toBe(true);
		expect(plan?.audienceUnderCounted).toBe(true);
	});

	it('does not claim a different refusal reason', () => {
		const other: OperationError = {
			category: 'invalid_state',
			message: 'no template',
			data: { reason: 'no_template' },
		};
		expect(capacityRefusalPlan(other)).toBeNull();
	});

	it('does not claim an error with no data at all', () => {
		expect(capacityRefusalPlan({ category: 'internal', message: 'boom' })).toBeNull();
	});

	it.each([
		['a missing plan', undefined],
		['a null plan', null],
		['a non-object plan', 'five days'],
		['a zero day count (the backend unknown-capacity sentinel)', { ...VALID_PLAN, days: 0 }],
		['a non-finite day count', { ...VALID_PLAN, days: Number.NaN }],
		['a non-finite finish instant', { ...VALID_PLAN, finishesAt: Number.POSITIVE_INFINITY }],
		['a missing covered count', { ...VALID_PLAN, covered: undefined }],
		['slices that are not an array', { ...VALID_PLAN, slices: 5 }],
		['slices carrying a non-number', { ...VALID_PLAN, slices: [1, '2'] }],
		['slices carrying NaN', { ...VALID_PLAN, slices: [1, Number.NaN] }],
	])('falls back to null for %s', (_label, plan) => {
		expect(capacityRefusalPlan(refusal(plan))).toBeNull();
	});
});

describe('capacityScheduleHeadline', () => {
	it('quotes the day count as the finish when the plan is complete', () => {
		expect(capacityScheduleHeadline({ ...VALID_PLAN })).toBe('Sending over 5 days');
	});

	it('quotes a floor when the audience is only known as a lower bound', () => {
		expect(capacityScheduleHeadline({ ...VALID_PLAN, audienceUnderCounted: true })).toBe(
			'Sending over at least 5 days'
		);
	});

	it('never quotes the day count as a finish for a truncated enumeration', () => {
		expect(capacityScheduleHeadline({ ...VALID_PLAN, truncated: true })).toBe(
			'Sending over more than 5 days'
		);
	});

	it('truncation wins over an under-counted audience — the weaker claim', () => {
		expect(
			capacityScheduleHeadline({ ...VALID_PLAN, truncated: true, audienceUnderCounted: true })
		).toBe('Sending over more than 5 days');
	});

	it('says "day" in the singular', () => {
		expect(capacityScheduleHeadline({ ...VALID_PLAN, days: 1, slices: [1] })).toBe(
			'Sending over 1 day'
		);
	});
});
