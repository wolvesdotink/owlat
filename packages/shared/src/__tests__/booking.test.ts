import { describe, expect, it } from 'vitest';
import {
	bookingRangeProblem,
	isBookingDateKey,
	isValidBookingSlug,
	suggestBookingSlug,
} from '../booking';

describe('booking slugs', () => {
	it('accepts lowercase words joined by single hyphens', () => {
		expect(isValidBookingSlug('ada-lovelace')).toBe(true);
		expect(isValidBookingSlug('30-min')).toBe(true);
		for (const bad of ['ab', 'manage', 'Ada', '-ada', 'ada-', 'ada--l', 'ada l', 'a'.repeat(41)]) {
			expect(isValidBookingSlug(bad), bad).toBe(false);
		}
	});

	it('suggests a slug from a name or a title', () => {
		expect(suggestBookingSlug('Ada Lovelace')).toBe('ada-lovelace');
		expect(suggestBookingSlug('Jürgen Müller')).toBe('jurgen-muller');
		expect(suggestBookingSlug('  30 min · intro!  ')).toBe('30-min-intro');
	});
});

describe('bookingRangeProblem', () => {
	it('finds bad bounds, inverted ranges, overlaps and too many ranges', () => {
		expect(bookingRangeProblem([{ startMinute: 540, endMinute: 1020 }])).toBeNull();
		expect(bookingRangeProblem([{ startMinute: -1, endMinute: 60 }])).toBe('bounds');
		expect(bookingRangeProblem([{ startMinute: 60, endMinute: 1441 }])).toBe('bounds');
		expect(bookingRangeProblem([{ startMinute: 600, endMinute: 600 }])).toBe('order');
		expect(
			bookingRangeProblem([
				{ startMinute: 540, endMinute: 720 },
				{ startMinute: 700, endMinute: 800 },
			])
		).toBe('overlap');
		const many = Array.from({ length: 7 }, (_, i) => ({
			startMinute: i * 60,
			endMinute: i * 60 + 30,
		}));
		expect(bookingRangeProblem(many)).toBe('tooMany');
	});
});

describe('isBookingDateKey', () => {
	it('accepts real calendar dates only', () => {
		expect(isBookingDateKey('2026-02-28')).toBe(true);
		expect(isBookingDateKey('2026-02-30')).toBe(false);
		expect(isBookingDateKey('2026-2-3')).toBe(false);
	});
});
