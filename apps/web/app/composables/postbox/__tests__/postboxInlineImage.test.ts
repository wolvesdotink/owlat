import { describe, it, expect } from 'vitest';
import {
	computeDownscaleDimensions,
	keepsPngFormat,
	MAX_INLINE_IMAGE_EDGE,
} from '../postboxInlineImage';

describe('computeDownscaleDimensions', () => {
	it('scales a wide landscape image down to the max edge, preserving aspect ratio', () => {
		const d = computeDownscaleDimensions(4000, 3000);
		expect(d.scaled).toBe(true);
		expect(d.width).toBe(MAX_INLINE_IMAGE_EDGE); // 1600
		expect(d.height).toBe(1200); // 3000 * (1600/4000)
	});

	it('scales a tall portrait image so the LONGEST edge (height) becomes the max', () => {
		const d = computeDownscaleDimensions(3000, 4000);
		expect(d.scaled).toBe(true);
		expect(d.height).toBe(MAX_INLINE_IMAGE_EDGE); // 1600
		expect(d.width).toBe(1200);
	});

	it('leaves a small image untouched (no scale, no rounding drift)', () => {
		const d = computeDownscaleDimensions(800, 600);
		expect(d.scaled).toBe(false);
		expect(d).toEqual({ width: 800, height: 600, scaled: false });
	});

	it('treats an image exactly at the max edge as a no-op', () => {
		const d = computeDownscaleDimensions(1600, 900);
		expect(d.scaled).toBe(false);
		expect(d.width).toBe(1600);
		expect(d.height).toBe(900);
	});

	it('rounds fractional scaled dimensions to whole pixels and never to zero', () => {
		const d = computeDownscaleDimensions(1601, 3);
		expect(d.scaled).toBe(true);
		expect(d.width).toBe(1600);
		expect(Number.isInteger(d.height)).toBe(true);
		expect(d.height).toBeGreaterThanOrEqual(1);
	});

	it('honours a custom max edge', () => {
		const d = computeDownscaleDimensions(1000, 500, 400);
		expect(d.scaled).toBe(true);
		expect(d.width).toBe(400);
		expect(d.height).toBe(200);
	});

	it('returns a safe zero result for degenerate dimensions', () => {
		expect(computeDownscaleDimensions(0, 0)).toEqual({ width: 0, height: 0, scaled: false });
		expect(computeDownscaleDimensions(NaN, 100).scaled).toBe(false);
	});
});

describe('keepsPngFormat', () => {
	it('keeps PNG as PNG (preserves transparency / screenshots)', () => {
		expect(keepsPngFormat('image/png')).toBe(true);
	});
	it('re-encodes other raster types (JPEG path)', () => {
		expect(keepsPngFormat('image/jpeg')).toBe(false);
		expect(keepsPngFormat('image/webp')).toBe(false);
	});
});
