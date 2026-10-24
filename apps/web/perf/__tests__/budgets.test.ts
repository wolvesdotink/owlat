/**
 * The budget gate's verdicts: what passes, what fails and how a failure names
 * itself. The budgets themselves come from browser runs (perf/README.md); this
 * suite pins the check that applies them.
 */
import { describe, expect, it } from 'vitest';
import { BUDGETS, checkBudgets, formatBudgetFailure } from '../budgets';
import { SCENARIOS } from '../scenarios';
import { counter, timing, type Sample } from '../stats';

const budgets = {
	'list/50': {
		'run: component updates': { max: 8 },
		'run: rows': { exact: 50 },
		'teardown: DOM nodes left': { max: 0 },
	},
};

const run = (overrides: Sample = {}): Sample => ({
	'run: component updates': counter(8),
	'run: rows': counter(50),
	'teardown: DOM nodes left': counter(0),
	'run: patch p95': timing(3.2),
	...overrides,
});

describe('checkBudgets', () => {
	it('a run exactly at its ceilings and identities passes', () => {
		expect(checkBudgets({ 'list/50': [run(), run()] }, budgets)).toEqual([]);
	});

	it('one over a ceiling fails, naming the scenario, metric and run', () => {
		const failures = checkBudgets(
			{ 'list/50': [run(), run({ 'run: component updates': counter(9) })] },
			budgets
		);
		expect(failures).toEqual([
			{
				scenario: 'list/50',
				metric: 'run: component updates',
				run: 2,
				message: 'measured 9, budget at most 8',
			},
		]);
		expect(formatBudgetFailure(failures[0]!)).toBe(
			'list/50 / run: component updates (run 2): measured 9, budget at most 8'
		);
	});

	it('a single bad run fails even when the median of the runs is within budget', () => {
		const runs = [run(), run(), run({ 'teardown: DOM nodes left': counter(1) }), run(), run()];
		expect(checkBudgets({ 'list/50': runs }, budgets).map((f) => [f.metric, f.run])).toEqual([
			['teardown: DOM nodes left', 3],
		]);
	});

	it('an identity fails in both directions: a fixture that delivered less is no pass', () => {
		const failures = checkBudgets(
			{ 'list/50': [run({ 'run: rows': counter(49) }), run({ 'run: rows': counter(51) })] },
			budgets
		);
		expect(failures.map((f) => f.message)).toEqual([
			'measured 49, budget exactly 50',
			'measured 51, budget exactly 50',
		]);
	});

	it('a budgeted metric a run did not measure fails', () => {
		const { 'run: rows': _rows, ...withoutRows } = run();
		expect(checkBudgets({ 'list/50': [withoutRows] }, budgets)).toEqual([
			{ scenario: 'list/50', metric: 'run: rows', run: 1, message: 'was not measured' },
		]);
	});

	it('a value that is not a finite number fails instead of slipping under a ceiling', () => {
		const failures = checkBudgets(
			{
				'list/50': [
					run({ 'run: component updates': counter(Number.NaN) }),
					run({ 'run: component updates': counter(Number.POSITIVE_INFINITY) }),
				],
			},
			budgets
		);
		expect(failures.map((f) => f.message)).toEqual([
			'measured NaN, not a number',
			'measured Infinity, not a number',
		]);
	});

	it('a scenario without budgets, or without runs, fails', () => {
		expect(checkBudgets({ 'list/500': [run()], 'list/50': [] }, budgets)).toEqual([
			{ scenario: 'list/500', message: 'has no committed budgets (perf/budgets.ts)' },
			{ scenario: 'list/50', message: 'produced no runs' },
		]);
	});

	it('a budget on a timing fails: wall-clock never gates', () => {
		const failures = checkBudgets(
			{ 'list/50': [run()] },
			{ 'list/50': { 'run: patch p95': { max: 100 } } }
		);
		expect(failures.map((f) => f.message)).toEqual(['is a timing; only counters carry a budget']);
	});

	it('timings and unbudgeted counters do not affect the verdict', () => {
		const noisy = run({ 'run: patch p95': timing(900), 'run: layouts': counter(1_000) });
		expect(checkBudgets({ 'list/50': [noisy] }, budgets)).toEqual([]);
	});

	it('scenarios that did not run are not checked', () => {
		expect(checkBudgets({}, budgets)).toEqual([]);
	});
});

describe('committed budgets', () => {
	it('every scenario has budgets and every budget belongs to a scenario', () => {
		expect(Object.keys(BUDGETS).sort()).toEqual(SCENARIOS.map((s) => s.id).sort());
	});

	it('every scenario budgets its teardown: nothing left mounted', () => {
		for (const id of Object.keys(BUDGETS)) {
			expect(BUDGETS[id]?.['teardown: components left mounted']).toEqual({ max: 0 });
		}
	});

	it('every budget is a non-negative integer', () => {
		for (const scenario of Object.values(BUDGETS)) {
			for (const budget of Object.values(scenario)) {
				const value = 'max' in budget ? budget.max : budget.exact;
				expect(Number.isInteger(value) && value >= 0).toBe(true);
			}
		}
	});
});
