import { describe, it, expect } from 'vitest';
import { calculateRiskLevel } from '../analytics/sendingReputation';

describe('calculateRiskLevel', () => {
	it('returns "low" when below minimum sample size', () => {
		expect(calculateRiskLevel(0.15, 0.005, 50)).toBe('low');
		expect(calculateRiskLevel(0.5, 0.1, 99)).toBe('low');
	});

	it('returns "low" when both rates are below medium thresholds', () => {
		expect(calculateRiskLevel(0.01, 0.0005, 1000)).toBe('low');
		expect(calculateRiskLevel(0, 0, 500)).toBe('low');
	});

	it('returns "medium" when bounce rate >= 2%', () => {
		expect(calculateRiskLevel(0.02, 0, 1000)).toBe('medium');
		expect(calculateRiskLevel(0.03, 0, 1000)).toBe('medium');
	});

	it('returns "medium" when complaint rate >= 0.1%', () => {
		expect(calculateRiskLevel(0, 0.001, 1000)).toBe('medium');
		expect(calculateRiskLevel(0.01, 0.0015, 1000)).toBe('medium');
	});

	it('returns "high" when bounce rate >= 5%', () => {
		expect(calculateRiskLevel(0.05, 0, 1000)).toBe('high');
		expect(calculateRiskLevel(0.07, 0, 1000)).toBe('high');
	});

	it('returns "high" when complaint rate >= 0.2%', () => {
		expect(calculateRiskLevel(0, 0.002, 1000)).toBe('high');
		expect(calculateRiskLevel(0.01, 0.0025, 1000)).toBe('high');
	});

	it('returns "critical" when bounce rate >= 10%', () => {
		expect(calculateRiskLevel(0.10, 0, 1000)).toBe('critical');
		expect(calculateRiskLevel(0.15, 0, 1000)).toBe('critical');
	});

	it('returns "critical" when complaint rate >= 0.3% (Gmail/Yahoo threshold)', () => {
		expect(calculateRiskLevel(0, 0.003, 1000)).toBe('critical');
		expect(calculateRiskLevel(0, 0.005, 1000)).toBe('critical');
	});

	it('returns highest severity when multiple thresholds exceeded', () => {
		// Both bounce (high) and complaint (critical)
		expect(calculateRiskLevel(0.06, 0.004, 1000)).toBe('critical');
		// Both bounce (medium) and complaint (high)
		expect(calculateRiskLevel(0.03, 0.002, 1000)).toBe('high');
	});

	it('handles exact threshold boundary (>=)', () => {
		// Exactly at medium threshold
		expect(calculateRiskLevel(0.02, 0, 100)).toBe('medium');
		// Exactly at high threshold
		expect(calculateRiskLevel(0.05, 0, 100)).toBe('high');
		// Exactly at critical threshold
		expect(calculateRiskLevel(0.10, 0, 100)).toBe('critical');
	});

	it('handles zero sends gracefully', () => {
		expect(calculateRiskLevel(0, 0, 0)).toBe('low');
	});
});
