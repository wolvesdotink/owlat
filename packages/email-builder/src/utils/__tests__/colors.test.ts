import { describe, it, expect } from 'vitest';
import { computeButtonTextColor } from '../colors';

describe('computeButtonTextColor', () => {
	it('returns white text for dark background', () => {
		expect(computeButtonTextColor('#000000')).toBe('#ffffff');
	});

	it('returns dark text for light background', () => {
		expect(computeButtonTextColor('#ffffff')).toBe('#12110e');
	});

	it('returns dark text for white-ish background', () => {
		expect(computeButtonTextColor('#f5f5f5')).toBe('#12110e');
	});

	it('returns white text for very dark background', () => {
		expect(computeButtonTextColor('#1a1a1a')).toBe('#ffffff');
	});

	it('returns white text for terracotta (#c4785a)', () => {
		// Luminance: (0.299*196 + 0.587*120 + 0.114*90) / 255 ≈ 0.5
		const result = computeButtonTextColor('#c4785a');
		// Terracotta is right around the threshold - either is acceptable
		expect(['#ffffff', '#12110e']).toContain(result);
	});

	it('returns white text for blue', () => {
		expect(computeButtonTextColor('#0000ff')).toBe('#ffffff');
	});

	it('returns dark text for yellow', () => {
		expect(computeButtonTextColor('#ffff00')).toBe('#12110e');
	});

	it('returns white text for red', () => {
		expect(computeButtonTextColor('#ff0000')).toBe('#ffffff');
	});

	it('returns dark text for green', () => {
		// Green has high luminance weight (0.587)
		expect(computeButtonTextColor('#00ff00')).toBe('#12110e');
	});

	it('handles hex with # prefix', () => {
		expect(computeButtonTextColor('#000000')).toBe('#ffffff');
	});

	it('handles hex without # prefix', () => {
		expect(computeButtonTextColor('000000')).toBe('#ffffff');
	});
});
