import { describe, it, expect } from 'vitest';
import { delayConfigToMs } from '../automations/stepWalker';
import type { DelayStepConfig } from '../automations/steps/delay';
import { evaluateContactPropertyOperator } from '../conditions/contact_property';
import type { PropertyOperator } from '../conditions/types';

// ============== delayConfigToMs ==============

describe('delayConfigToMs', () => {
	describe('minutes', () => {
		it('1 minute → 60000ms', () => {
			expect(delayConfigToMs({ duration: 1, unit: 'minutes' })).toBe(60_000);
		});
		it('30 minutes → 1_800_000ms', () => {
			expect(delayConfigToMs({ duration: 30, unit: 'minutes' })).toBe(1_800_000);
		});
		it('0 minutes', () => {
			expect(delayConfigToMs({ duration: 0, unit: 'minutes' })).toBe(0);
		});
	});

	describe('hours', () => {
		it('1 hour → 3_600_000ms', () => {
			expect(delayConfigToMs({ duration: 1, unit: 'hours' })).toBe(3_600_000);
		});
		it('24 hours → 86_400_000ms', () => {
			expect(delayConfigToMs({ duration: 24, unit: 'hours' })).toBe(86_400_000);
		});
		it('fractional hours', () => {
			expect(delayConfigToMs({ duration: 1.5, unit: 'hours' })).toBe(5_400_000);
		});
	});

	describe('days', () => {
		it('1 day → 86_400_000ms', () => {
			expect(delayConfigToMs({ duration: 1, unit: 'days' })).toBe(86_400_000);
		});
		it('7 days → 604_800_000ms', () => {
			expect(delayConfigToMs({ duration: 7, unit: 'days' })).toBe(604_800_000);
		});
	});

	describe('weeks', () => {
		it('1 week → 604_800_000ms', () => {
			expect(delayConfigToMs({ duration: 1, unit: 'weeks' })).toBe(604_800_000);
		});
		it('4 weeks == 28 days', () => {
			const weeks: DelayStepConfig = { duration: 4, unit: 'weeks' };
			const days: DelayStepConfig = { duration: 28, unit: 'days' };
			expect(delayConfigToMs(weeks)).toBe(delayConfigToMs(days));
		});
	});

	describe('consistency', () => {
		it('1 day == 24 hours', () => {
			expect(delayConfigToMs({ duration: 1, unit: 'days' })).toBe(
				delayConfigToMs({ duration: 24, unit: 'hours' })
			);
		});
		it('1 hour == 60 minutes', () => {
			expect(delayConfigToMs({ duration: 1, unit: 'hours' })).toBe(
				delayConfigToMs({ duration: 60, unit: 'minutes' })
			);
		});
	});
});

// ============== contact_property operators ==============

function op(operator: PropertyOperator, fv: unknown, cv: unknown): boolean {
	return evaluateContactPropertyOperator(operator, fv, cv);
}

describe('evaluateContactPropertyOperator', () => {
	describe('equals (case-insensitive per legacy contract)', () => {
		it('matches identical strings', () => {
			expect(op('equals', 'hello', 'hello')).toBe(true);
		});
		it('matches mixed case', () => {
			expect(op('equals', 'Hello', 'hello')).toBe(true);
		});
		it('rejects different values', () => {
			expect(op('equals', 'hello', 'world')).toBe(false);
		});
		it('matches undefined→undefined', () => {
			expect(op('equals', undefined, undefined)).toBe(true);
		});
	});

	describe('not_equals', () => {
		it('differs', () => {
			expect(op('not_equals', 'hello', 'world')).toBe(true);
		});
		it('matches', () => {
			expect(op('not_equals', 'hello', 'hello')).toBe(false);
		});
	});

	describe('contains', () => {
		it('substring match', () => {
			expect(op('contains', 'hello world', 'world')).toBe(true);
		});
		it('case insensitive', () => {
			expect(op('contains', 'Hello World', 'hello')).toBe(true);
		});
		it('no match', () => {
			expect(op('contains', 'hello', 'world')).toBe(false);
		});
	});

	describe('not_contains', () => {
		it('inverse of contains', () => {
			expect(op('not_contains', 'hello world', 'world')).toBe(false);
			expect(op('not_contains', 'hello', 'world')).toBe(true);
		});
	});

	describe('gt / lt / gte / lte', () => {
		it('gt: 10 > 5', () => {
			expect(op('gt', '10', '5')).toBe(true);
		});
		it('gt: equal is false', () => {
			expect(op('gt', '10', '10')).toBe(false);
		});
		it('lt: 5 < 10', () => {
			expect(op('lt', '5', '10')).toBe(true);
		});
		it('gte: equal is true', () => {
			expect(op('gte', '10', '10')).toBe(true);
		});
		it('lte: equal is true', () => {
			expect(op('lte', '10', '10')).toBe(true);
		});
	});

	describe('is_empty / not_empty', () => {
		it('is_empty: undefined', () => {
			expect(op('is_empty', undefined, undefined)).toBe(true);
		});
		it('is_empty: empty string', () => {
			expect(op('is_empty', '', undefined)).toBe(true);
		});
		it('is_empty: value', () => {
			expect(op('is_empty', 'value', undefined)).toBe(false);
		});
		it('not_empty: value', () => {
			expect(op('not_empty', 'value', undefined)).toBe(true);
		});
		it('not_empty: empty', () => {
			expect(op('not_empty', '', undefined)).toBe(false);
		});
	});

	describe('is_true / is_false', () => {
		it('is_true: boolean true', () => {
			expect(op('is_true', true, undefined)).toBe(true);
		});
		it('is_true: string "true"', () => {
			expect(op('is_true', 'true', undefined)).toBe(true);
		});
		it('is_false: boolean false', () => {
			expect(op('is_false', false, undefined)).toBe(true);
		});
	});
});

