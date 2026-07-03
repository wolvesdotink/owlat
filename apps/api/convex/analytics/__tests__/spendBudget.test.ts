/**
 * Pure evaluation core of the per-org spend budget: under budget → allowed;
 * over budget → autonomous auto-send withheld + advisory blocked with a clear
 * reason; the advisory reserve blocks advisory before the hard ceiling.
 */
import { describe, it, expect } from 'vitest';
import {
	evaluatePeriod,
	evaluateBudget,
	type SpendBudgetConfig,
} from '../spendBudget';

const config: SpendBudgetConfig = {
	dailyUsd: 10,
	monthlyUsd: 100,
	warnFraction: 0.8,
	advisoryReserveFraction: 0.2,
};

describe('evaluatePeriod', () => {
	it('is unconfigured + always-allowed when the limit is 0', () => {
		const p = evaluatePeriod(0, 999, 0.8, 0.2);
		expect(p.configured).toBe(false);
		expect(p.state).toBe('ok');
		expect(p.advisoryAllowed).toBe(true);
	});

	it('reports ok / remaining headroom well under budget', () => {
		const p = evaluatePeriod(10, 2, 0.8, 0.2);
		expect(p.state).toBe('ok');
		expect(p.remainingUsd).toBeCloseTo(8);
		expect(p.advisoryAllowed).toBe(true);
	});

	it('warns at the warn fraction but still allows', () => {
		const p = evaluatePeriod(10, 8.5, 0.8, 0.2);
		expect(p.state).toBe('warn');
		expect(p.advisoryAllowed).toBe(true);
	});

	it('blocks advisory once remaining drops within the reserve', () => {
		// remaining 1.5 <= reserve floor 2.0 → advisory blocked, but not exceeded.
		const p = evaluatePeriod(10, 8.5, 0.8, 0.2);
		// spend 8.5 leaves 1.5 remaining vs reserve floor 2.0
		expect(p.remainingUsd).toBeCloseTo(1.5);
		expect(p.advisoryAllowed).toBe(false);
		expect(p.state).toBe('warn');
	});

	it('is exceeded (remaining 0) once spend reaches the ceiling', () => {
		const p = evaluatePeriod(10, 10, 0.8, 0.2);
		expect(p.state).toBe('exceeded');
		expect(p.remainingUsd).toBe(0);
		expect(p.advisoryAllowed).toBe(false);
	});
});

describe('evaluateBudget', () => {
	it('allows both paths well under budget', () => {
		const s = evaluateBudget(config, 1, 5);
		expect(s.autonomousAutoSendAllowed).toBe(true);
		expect(s.advisoryAllowed).toBe(true);
		expect(s.state).toBe('ok');
		expect(s.reason).toBe('');
	});

	it('withholds autonomous auto-send + blocks advisory with a reason when a period is exceeded', () => {
		const s = evaluateBudget(config, 10, 20); // daily ceiling hit
		expect(s.autonomousAutoSendAllowed).toBe(false);
		expect(s.advisoryAllowed).toBe(false);
		expect(s.state).toBe('exceeded');
		expect(s.reason).toMatch(/spend budget/i);
		expect(s.reason).toMatch(/human review/i);
	});

	it('pauses advisory within the reserve while autonomous auto-send is still allowed', () => {
		// daily remaining 1.5 (<= reserve 2.0) blocks advisory, but not exceeded.
		const s = evaluateBudget(config, 8.5, 20);
		expect(s.autonomousAutoSendAllowed).toBe(true);
		expect(s.advisoryAllowed).toBe(false);
		expect(s.reason).toMatch(/reserve|paused/i);
	});

	it('is unconfigured + fully permissive when no ceiling is set', () => {
		const s = evaluateBudget(
			{ dailyUsd: 0, monthlyUsd: 0, warnFraction: 0.8, advisoryReserveFraction: 0.2 },
			9999,
			9999
		);
		expect(s.configured).toBe(false);
		expect(s.autonomousAutoSendAllowed).toBe(true);
		expect(s.advisoryAllowed).toBe(true);
	});

	it('takes the worst state across daily and monthly', () => {
		const s = evaluateBudget(config, 1, 100); // monthly exceeded, daily ok
		expect(s.state).toBe('exceeded');
		expect(s.autonomousAutoSendAllowed).toBe(false);
	});
});
