import { describe, it, expect } from 'vitest';
import { scoreComplexity, isTrivialUserText, COMPLEXITY_DOWNGRADE_THRESHOLD } from '../complexity';

describe('scoreComplexity', () => {
	it('scores trivial acknowledgements at/below the downgrade threshold', () => {
		for (const t of ['thanks!', 'ok got it', 'sounds good', 'yes', 'will do', '']) {
			expect(scoreComplexity(t)).toBeLessThanOrEqual(COMPLEXITY_DOWNGRADE_THRESHOLD);
		}
	});

	it('scores code / structured payloads as complex', () => {
		expect(scoreComplexity('Write a function to dedupe this list: ```const x = [1,2,2]```')).toBeGreaterThan(
			COMPLEXITY_DOWNGRADE_THRESHOLD,
		);
		expect(scoreComplexity('SELECT * FROM contacts WHERE created_at > now()')).toBeGreaterThan(
			COMPLEXITY_DOWNGRADE_THRESHOLD,
		);
	});

	it('scores long, multi-part analytical asks as complex', () => {
		const q =
			'Compare our Q1 and Q2 churn, explain why it changed, and also outline a step by step plan to reduce it next quarter.';
		expect(scoreComplexity(q)).toBeGreaterThan(COMPLEXITY_DOWNGRADE_THRESHOLD);
	});

	it('is bounded to [0, 1]', () => {
		expect(scoreComplexity('x'.repeat(5000))).toBeLessThanOrEqual(1);
		expect(scoreComplexity('')).toBe(0);
	});
});

describe('isTrivialUserText', () => {
	it('flags trivial text and spares complex text', () => {
		expect(isTrivialUserText('thanks, got it')).toBe(true);
		expect(isTrivialUserText('Explain why our deliverability dropped and how to analyze the bounce logs')).toBe(false);
	});
});
