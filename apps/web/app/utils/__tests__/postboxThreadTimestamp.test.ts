import { describe, expect, it } from 'vitest';
import { formatThreadTimestamp } from '../postboxThreadTimestamp';

const NOW = new Date(2026, 8, 29, 12, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const en = { now: NOW, locale: 'en', justNow: 'just now' };
const de = { now: NOW, locale: 'de', justNow: 'gerade eben' };

describe('formatThreadTimestamp', () => {
	it('keeps the English column exactly as it was: 5m, 3h, 2d, then a date', () => {
		expect(formatThreadTimestamp(NOW - 30_000, en)).toBe('just now');
		expect(formatThreadTimestamp(NOW - 5 * MINUTE, en)).toBe('5m');
		expect(formatThreadTimestamp(NOW - 3 * HOUR - 10 * MINUTE, en)).toBe('3h');
		expect(formatThreadTimestamp(NOW - 2 * DAY - HOUR, en)).toBe('2d');
		expect(formatThreadTimestamp(new Date(2026, 8, 3, 9).getTime(), en)).toBe('Sep 3');
	});

	it('speaks the active locale instead of en-US', () => {
		expect(formatThreadTimestamp(NOW - 30_000, de)).toBe('gerade eben');
		expect(formatThreadTimestamp(NOW - 5 * MINUTE, de)).toBe(
			new Intl.NumberFormat('de', { style: 'unit', unit: 'minute', unitDisplay: 'narrow' }).format(
				5
			)
		);
		expect(formatThreadTimestamp(NOW - 5 * MINUTE, de)).not.toBe('5m');
		expect(formatThreadTimestamp(new Date(2026, 8, 3, 9).getTime(), de)).toBe(
			new Intl.DateTimeFormat('de', { month: 'short', day: 'numeric' }).format(
				new Date(2026, 8, 3, 9)
			)
		);
	});

	it('measures against the clock it is handed, not Date.now()', () => {
		const sent = NOW - 30_000;
		expect(formatThreadTimestamp(sent, en)).toBe('just now');
		expect(formatThreadTimestamp(sent, { ...en, now: NOW + 2 * MINUTE })).toBe('2m');
	});

	it('treats a timestamp from the future (clock skew) as just now', () => {
		expect(formatThreadTimestamp(NOW + 5 * MINUTE, en)).toBe('just now');
	});
});
