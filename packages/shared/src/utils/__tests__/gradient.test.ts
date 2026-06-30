import { describe, it, expect } from 'vitest';
import { gradientToCss, gradientToCssOrUndefined } from '../gradient';

describe('gradientToCss', () => {
	it('builds a linear-gradient with the declared direction', () => {
		expect(
			gradientToCss({
				direction: 'to right',
				stops: [
					{ color: '#000', position: 0 },
					{ color: '#fff', position: 100 },
				],
			}),
		).toBe('linear-gradient(to right, #000 0%, #fff 100%)');
	});

	it('sorts stops by position so out-of-order input renders consistently', () => {
		expect(
			gradientToCss({
				direction: '135deg',
				stops: [
					{ color: '#fff', position: 100 },
					{ color: '#000', position: 0 },
				],
			}),
		).toBe('linear-gradient(135deg, #000 0%, #fff 100%)');
	});

	it('falls back to "to bottom" when direction is empty', () => {
		expect(gradientToCss({ direction: '', stops: [{ color: '#000', position: 0 }] })).toBe(
			'linear-gradient(to bottom, #000 0%)',
		);
	});
});

describe('gradientToCssOrUndefined', () => {
	const g = (n: number) => ({
		direction: 'to bottom',
		stops: Array.from({ length: n }, (_, i) => ({ color: '#000', position: i })),
	});

	it('returns undefined for an absent gradient', () => {
		expect(gradientToCssOrUndefined(undefined)).toBeUndefined();
	});

	it('requires two stops by default', () => {
		expect(gradientToCssOrUndefined(g(1))).toBeUndefined();
		expect(gradientToCssOrUndefined(g(2))).toContain('linear-gradient');
	});

	it('honours minStops: 1 for the single-stop Hero case', () => {
		expect(gradientToCssOrUndefined(g(1), 1)).toContain('linear-gradient');
	});
});
