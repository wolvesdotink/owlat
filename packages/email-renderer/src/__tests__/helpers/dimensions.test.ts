import { describe, it, expect } from 'vitest';
import { toPixelWidth, toPercentNumber } from '../../helpers/dimensions';

describe('toPixelWidth', () => {
	it('converts percentage to pixel width', () => {
		expect(toPixelWidth(50, 600)).toBe(300);
		expect(toPixelWidth(100, 600)).toBe(600);
		expect(toPixelWidth(33, 600)).toBe(198);
	});

	it('returns base width for undefined percent', () => {
		expect(toPixelWidth(undefined, 600)).toBe(600);
	});

	it('clamps to valid range', () => {
		expect(toPixelWidth(0, 600)).toBe(6);
		expect(toPixelWidth(150, 600)).toBe(600);
	});

	it('handles NaN', () => {
		expect(toPixelWidth(NaN, 600)).toBe(600);
	});
});

describe('toPercentNumber', () => {
	it('parses percentage strings', () => {
		expect(toPercentNumber('50%')).toBe(50);
		expect(toPercentNumber('33.33%')).toBe(33.33);
		expect(toPercentNumber('100%')).toBe(100);
	});

	it('returns fallback for invalid strings', () => {
		expect(toPercentNumber('abc', 100)).toBe(100);
		expect(toPercentNumber('', 50)).toBe(50);
	});
});
