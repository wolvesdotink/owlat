import { describe, expect, it } from 'vitest';
import { compareDerived, planSample } from '../maintenance/derivedFields/sampler';
import { spendPeriodRange } from '../maintenance/derivedFields/adapters';
import { RecountBudget, recountWithin } from '../maintenance/derivedFields/types';

const rows = (eligible: boolean[]) =>
	eligible.map((isEligible, i) => ({ id: `p${i}`, creationTime: 100 + i, isEligible }));

describe('planSample', () => {
	it('stops at the sample size and keeps the unvisited rows ahead of the mark', () => {
		expect(planSample(rows([true, true, true, true]), 4, 2)).toEqual({
			picked: ['p0', 'p1'],
			afterCreationTime: 101,
			wrapped: false,
		});
	});

	it('passes over ineligible rows and moves the mark past them', () => {
		expect(planSample(rows([false, true, false, false]), 4, 2)).toEqual({
			picked: ['p1'],
			afterCreationTime: 103,
			wrapped: false,
		});
	});

	it('wraps when a scan comes back short of its limit', () => {
		expect(planSample(rows([true]), 8, 2)).toEqual({
			picked: ['p0'],
			afterCreationTime: undefined,
			wrapped: true,
		});
		expect(planSample([], 8, 2)).toEqual({
			picked: [],
			afterCreationTime: undefined,
			wrapped: true,
		});
	});

	it('does not wrap when the last row filled the sample and the scan was full', () => {
		expect(planSample(rows([true, true]), 2, 2)).toEqual({
			picked: ['p0', 'p1'],
			afterCreationTime: 101,
			wrapped: false,
		});
	});
});

describe('compareDerived', () => {
	it('repairs any difference under the exact policy', () => {
		expect(compareDerived({ policy: 'exact' }, { a: 3, b: 'x' }, { a: 2, b: 'x' })).toEqual({
			drifted: ['a'],
			isRepairable: true,
		});
	});

	it('only raises under the raise_only policy', () => {
		expect(compareDerived({ policy: 'raise_only' }, { n: 1 }, { n: 4 })).toEqual({
			drifted: ['n'],
			isRepairable: true,
		});
		expect(compareDerived({ policy: 'raise_only' }, { n: 9 }, { n: 4 })).toEqual({
			drifted: ['n'],
			isRepairable: false,
		});
	});

	it('finds nothing when the values agree', () => {
		expect(compareDerived({ policy: 'exact' }, { n: 0 }, { n: 0 }).drifted).toEqual([]);
	});
});

describe('spendPeriodRange', () => {
	it('covers one UTC day or one UTC month', () => {
		expect(spendPeriodRange('day', '2026-10-24')).toEqual({
			start: Date.UTC(2026, 9, 24),
			end: Date.UTC(2026, 9, 25),
		});
		expect(spendPeriodRange('month', '2026-12')).toEqual({
			start: Date.UTC(2026, 11, 1),
			end: Date.UTC(2027, 0, 1),
		});
		expect(spendPeriodRange('day', 'not-a-day')).toBeNull();
	});
});

describe('recountWithin', () => {
	async function* source(n: number) {
		for (let i = 0; i < n; i++) yield { i };
	}

	it('gives up once the row allowance is exceeded, and stops reading', async () => {
		const budget = new RecountBudget(3);
		let seen = 0;
		expect(await recountWithin(source(10), budget, () => seen++)).toBe(false);
		expect(seen).toBe(3);
		expect(budget.rows).toBe(4);
	});

	it('gives up on bytes before rows', async () => {
		const budget = new RecountBudget(100, 200);
		expect(await recountWithin(source(10), budget, () => {})).toBe(false);
		expect(budget.rows).toBeLessThan(10);
	});

	it('visits every row of a source inside the allowance', async () => {
		let seen = 0;
		expect(await recountWithin(source(3), new RecountBudget(3), () => seen++)).toBe(true);
		expect(seen).toBe(3);
	});
});
