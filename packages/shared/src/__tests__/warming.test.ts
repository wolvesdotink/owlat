import { describe, expect, it } from 'vitest';
import {
	getNonGraduatedWarmingCapRepairFallback,
	isValidNonGraduatedWarmingCap,
	LAST_FINITE_WARMING_CAP,
	normalizeNonGraduatedWarmingCap,
	NON_GRADUATED_WARMING_CAP_RANGE,
} from '../warming';

describe('non-graduated warming-cap contract', () => {
	const invalidCaps: ReadonlyArray<{ name: string; value: unknown }> = [
		{ name: 'missing', value: undefined },
		{ name: 'NaN', value: Number.NaN },
		{ name: 'non-numeric', value: 'garbage' },
		{ name: 'positive Infinity', value: Infinity },
		{ name: 'negative Infinity', value: -Infinity },
		{ name: 'zero', value: 0 },
		{ name: 'negative', value: -5 },
		{ name: 'fractional', value: 1.5 },
		{ name: 'above the ceiling', value: LAST_FINITE_WARMING_CAP + 1 },
	];

	it.each(invalidCaps)('rejects and normalizes $name conservatively', ({ value }) => {
		expect(isValidNonGraduatedWarmingCap(value)).toBe(false);
		expect(normalizeNonGraduatedWarmingCap(value, 2)).toBe(100);
	});

	it('accepts both inclusive integer boundaries', () => {
		expect(isValidNonGraduatedWarmingCap(NON_GRADUATED_WARMING_CAP_RANGE.minimum)).toBe(true);
		expect(isValidNonGraduatedWarmingCap(NON_GRADUATED_WARMING_CAP_RANGE.maximum)).toBe(true);
	});

	it('uses the current schedule day without ever crossing into graduated Infinity', () => {
		expect(getNonGraduatedWarmingCapRepairFallback(1)).toBe(50);
		expect(getNonGraduatedWarmingCapRepairFallback(5)).toBe(700);
		expect(getNonGraduatedWarmingCapRepairFallback(30)).toBe(LAST_FINITE_WARMING_CAP);
		expect(getNonGraduatedWarmingCapRepairFallback(300)).toBe(LAST_FINITE_WARMING_CAP);
	});

	it('fails an invalid schedule day closed to the minimum cap', () => {
		expect(getNonGraduatedWarmingCapRepairFallback(Number.NaN)).toBe(
			NON_GRADUATED_WARMING_CAP_RANGE.minimum
		);
		expect(getNonGraduatedWarmingCapRepairFallback(-1)).toBe(
			NON_GRADUATED_WARMING_CAP_RANGE.minimum
		);
	});
});
