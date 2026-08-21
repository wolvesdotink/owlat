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

import {
	capacityFinishDayAt,
	capacityFinishSentence,
	capacityRefusalPlan,
	capacityScheduleHeadline,
	capacitySliceDayStart,
	formatCapacityDay,
	isCapacityDayToday,
	type CampaignCapacitySchedulePlan,
	type CapacityMessage,
} from '../campaignCapacityRefusal';
import { createTestI18n } from '~/__tests__/i18n';

/**
 * The module decides the sentence but never speaks it: module scope cannot call
 * `useI18n`, so it returns a catalog key plus its parameters. Rendering through
 * the real catalog keeps these assertions on the words the panel shows.
 */
const { t } = createTestI18n().global;
const render = (message: CapacityMessage | null): string | null =>
	message === null ? null : t(message.key, message.params ?? {});

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
		// THE DOCBLOCK'S PROMISE, ENFORCED. `capacitySliceDayStart` dates every row
		// backwards from `finishesAt` through `days`, so a slice list of a different
		// length labels each row with a date the backend never scheduled it for.
		['fewer slices than days', { ...VALID_PLAN, slices: [0, 100, 200] }],
		['more slices than days', { ...VALID_PLAN, slices: [0, 100, 200, 200, 100, 50] }],
		['an empty slice list', { ...VALID_PLAN, slices: [] }],
	])('falls back to null for %s', (_label, plan) => {
		expect(capacityRefusalPlan(refusal(plan))).toBeNull();
	});

	it('accepts a plan whose slices cover exactly its days', () => {
		const plan = capacityRefusalPlan(refusal({ ...VALID_PLAN, days: 2, slices: [400, 200] }));
		expect(plan?.days).toBe(2);
		expect(plan?.slices).toEqual([400, 200]);
	});
});

describe('capacityScheduleHeadline', () => {
	it('quotes the day count as the finish when the plan is complete', () => {
		expect(render(capacityScheduleHeadline({ ...VALID_PLAN }))).toBe('Sending over 5 days');
	});

	it('quotes a floor when the audience is only known as a lower bound', () => {
		expect(render(capacityScheduleHeadline({ ...VALID_PLAN, audienceUnderCounted: true }))).toBe(
			'Sending over at least 5 days'
		);
	});

	it('never quotes the day count as a finish for a truncated enumeration', () => {
		expect(render(capacityScheduleHeadline({ ...VALID_PLAN, truncated: true }))).toBe(
			'Sending over more than 5 days'
		);
	});

	it('truncation wins over an under-counted audience — the weaker claim', () => {
		expect(
			render(
				capacityScheduleHeadline({ ...VALID_PLAN, truncated: true, audienceUnderCounted: true })
			)
		).toBe('Sending over more than 5 days');
	});

	it('says "day" in the singular', () => {
		expect(render(capacityScheduleHeadline({ ...VALID_PLAN, days: 1, slices: [1] }))).toBe(
			'Sending over 1 day'
		);
	});
});

describe('capacity plan dates', () => {
	// Five days ending at Jan 10 00:00 UTC — the only shape the backend emits
	// (`capacityPlan.ts`: utcDayStart(startsAt) + days * MS_PER_DAY). The slices
	// therefore send on Jan 5..Jan 9 UTC.
	const PLAN: CampaignCapacitySchedulePlan = {
		days: 5,
		slices: [0, 100, 200, 200, 100],
		finishesAt: Date.UTC(2026, 0, 10),
		covered: 600,
		truncated: false,
		audienceUnderCounted: false,
	};

	it('anchors slice 0 on the send start, not on the finish', () => {
		expect(capacitySliceDayStart(PLAN, 0)).toBe(Date.UTC(2026, 0, 5));
		expect(capacitySliceDayStart(PLAN, PLAN.days - 1)).toBe(Date.UTC(2026, 0, 9));
	});

	it('closes the half-open finish interval inside the last sending day', () => {
		const at = capacityFinishDayAt(PLAN);
		expect(at).toBeLessThan(PLAN.finishesAt);
		expect(at).toBeGreaterThanOrEqual(Date.UTC(2026, 0, 9));
		expect(formatCapacityDay(at)).toBe('Friday, January 9');
	});

	it('formats in UTC regardless of the viewer timezone', () => {
		// A UTC midnight is the previous local day in every negative offset and the
		// same local day in every positive one, so a locally-formatted plan shows
		// two operators two different dates. These assertions are timezone-free by
		// construction: the formatter is pinned to UTC.
		expect(formatCapacityDay(Date.UTC(2026, 0, 5))).toBe('Monday, January 5');
		expect(formatCapacityDay(Date.UTC(2026, 0, 5, 23, 59, 59, 999))).toBe('Monday, January 5');
		expect(formatCapacityDay(Date.UTC(2026, 0, 6), 'short')).toBe('Tue, Jan 6');
	});

	/**
	 * The ZONE is pinned; the LANGUAGE is not. Every caller sits inside a
	 * component and hands over `useI18n().locale.value`, so a German page reads
	 * German dates — of the same UTC day, which is the part that must not move.
	 */
	it('formats in the language it is given', () => {
		expect(formatCapacityDay(Date.UTC(2026, 0, 9), 'long', 'de')).toBe('Freitag, 9. Januar');
		expect(formatCapacityDay(Date.UTC(2026, 0, 9), 'short', 'de')).toBe('Fr., 9. Jan.');
	});

	it('calls a day "today" only when it is the current UTC day', () => {
		expect(isCapacityDayToday(Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 5, 12))).toBe(true);
		expect(isCapacityDayToday(Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 5))).toBe(true);
		expect(isCapacityDayToday(Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 4, 23, 59))).toBe(false);
		expect(isCapacityDayToday(Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 6))).toBe(false);
	});

	/**
	 * The finish sentence has to make the SAME claim as the headline. A headline
	 * that says "at least 5 days" beside a flat "Everyone is reached by Friday"
	 * hands the operator back the exact date the plan just said it does not have.
	 */
	describe('capacityFinishSentence', () => {
		it('names the finish day when the plan knows one', () => {
			expect(render(capacityFinishSentence(PLAN))).toBe(
				'Everyone is reached by Friday, January 9.'
			);
		});

		it('qualifies the finish day when the audience is only a lower bound', () => {
			expect(render(capacityFinishSentence({ ...PLAN, audienceUnderCounted: true }))).toBe(
				'Everyone is reached by Friday, January 9 at the earliest.'
			);
		});

		it('makes no finish claim at all for a truncated enumeration', () => {
			expect(capacityFinishSentence({ ...PLAN, truncated: true })).toBeNull();
		});

		it('names that day in the locale it is given', () => {
			// Rendered through the English catalog on purpose: the sentence around
			// the date is the panel's, the date inside it is the caller's locale.
			expect(render(capacityFinishSentence(PLAN, 'de'))).toContain('Freitag, 9. Januar');
		});
	});
});
