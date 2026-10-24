import { describe, expect, it } from 'vitest';
import { compareDerived, planPage } from '../maintenance/derivedFields/sampler';
import { spendPeriodRange } from '../maintenance/derivedFields/adapters';
import { RecountBudget, recountWithin } from '../maintenance/derivedFields/types';

const page = (eligible: boolean[], rest: { isDone?: boolean; pageStatus?: string } = {}) => ({
	rows: eligible.map((isEligible, i) => ({ id: `p${i}`, isEligible })),
	isDone: rest.isDone ?? false,
	continueCursor: 'next',
	pageStatus: rest.pageStatus ?? null,
});

const at = (remaining: number, pagesLeft = 4) => ({ cursor: 'here', remaining, pagesLeft });

describe('planPage', () => {
	it('picks a full page and moves the cursor past it', () => {
		expect(planPage(page([true, true]), at(2))).toEqual({
			picked: ['p0', 'p1'],
			cursor: 'next',
			wrapped: false,
			nextPageRows: undefined,
		});
	});

	it('passes over ineligible rows and asks for the rest of the sample', () => {
		expect(planPage(page([false, true, false]), at(3))).toEqual({
			picked: ['p1'],
			cursor: 'next',
			wrapped: false,
			nextPageRows: 2,
		});
	});

	it('stops asking once the tick has no pages left', () => {
		expect(planPage(page([false, false]), at(2, 1)).nextPageRows).toBeUndefined();
	});

	it('wraps at the end of the table and starts the next pass at the oldest row', () => {
		expect(planPage(page([true], { isDone: true }), at(2))).toEqual({
			picked: ['p0'],
			cursor: null,
			wrapped: true,
			nextPageRows: undefined,
		});
		expect(planPage(page([], { isDone: true }), at(2))).toMatchObject({
			cursor: null,
			wrapped: true,
		});
	});

	it('keeps its place and halves the page when the byte bound cut it short', () => {
		expect(
			planPage(page([true, true, true, true, true], { pageStatus: 'SplitRequired' }), at(5))
		).toEqual({
			picked: [],
			cursor: 'here',
			wrapped: false,
			nextPageRows: 2,
		});
		// One row is complete however the page was stopped.
		expect(planPage(page([true], { pageStatus: 'SplitRequired' }), at(5))).toMatchObject({
			picked: ['p0'],
			cursor: 'next',
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
