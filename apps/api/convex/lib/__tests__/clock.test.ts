import { describe, expect, it } from 'vitest';
import { denseDailySeries, nextUtcDayStart, resolveNow, utcDayKey, utcDayStart } from '../clock';

const DAY = 24 * 60 * 60 * 1000;
const MIDNIGHT = Date.UTC(2026, 8, 3);

/**
 * The key `lib/sendDailyStats.ts` wrote before it imported `utcDayKey`, kept
 * here verbatim: rows already in the table were written under this spelling,
 * so the shared key must reproduce it byte for byte.
 */
function legacySendDailyStatsKey(at: number): string {
	const d = new Date(at);
	const yyyy = d.getUTCFullYear();
	const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(d.getUTCDate()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd}`;
}

describe('utcDayStart', () => {
	it('floors to midnight UTC', () => {
		expect(utcDayStart(MIDNIGHT)).toBe(MIDNIGHT);
		expect(utcDayStart(MIDNIGHT + 1)).toBe(MIDNIGHT);
		expect(utcDayStart(MIDNIGHT + DAY - 1)).toBe(MIDNIGHT);
		expect(utcDayStart(MIDNIGHT + DAY)).toBe(MIDNIGHT + DAY);
	});

	it('agrees with the setUTCHours spelling it replaced', () => {
		for (const at of [
			0,
			1,
			MIDNIGHT - 1,
			MIDNIGHT + 12 * 60 * 60 * 1000,
			Date.UTC(2024, 1, 29, 23, 59, 59, 999),
		]) {
			expect(utcDayStart(at)).toBe(new Date(at).setUTCHours(0, 0, 0, 0));
		}
	});

	it('answers 0 for a non-finite clock, so a daily cap window fails closed', () => {
		expect(utcDayStart(Number.NaN)).toBe(0);
		expect(utcDayStart(Number.POSITIVE_INFINITY)).toBe(0);
		expect(utcDayStart(Number.NEGATIVE_INFINITY)).toBe(0);
	});
});

describe('nextUtcDayStart', () => {
	it('is the following midnight, also exactly on a boundary', () => {
		expect(nextUtcDayStart(MIDNIGHT)).toBe(MIDNIGHT + DAY);
		expect(nextUtcDayStart(MIDNIGHT + DAY - 1)).toBe(MIDNIGHT + DAY);
	});
});

describe('utcDayKey', () => {
	it('spells the UTC day as zero-padded YYYY-MM-DD', () => {
		expect(utcDayKey(Date.UTC(2026, 0, 5, 23, 59))).toBe('2026-01-05');
		expect(utcDayKey(MIDNIGHT)).toBe('2026-09-03');
		expect(utcDayKey(MIDNIGHT - 1)).toBe('2026-09-02');
	});

	it('is byte-identical to the key sendDailyStats rows were written under', () => {
		const instants = [
			0,
			MIDNIGHT,
			MIDNIGHT - 1,
			MIDNIGHT + DAY - 1,
			Date.UTC(2024, 1, 29, 12),
			Date.UTC(2026, 11, 31, 23, 59, 59, 999),
			Date.UTC(2027, 0, 1),
		];
		for (const at of instants) expect(utcDayKey(at)).toBe(legacySendDailyStatsKey(at));
	});

	it('answers the empty string for a non-finite clock', () => {
		expect(utcDayKey(Number.NaN)).toBe('');
		expect(utcDayKey(Number.POSITIVE_INFINITY)).toBe('');
	});
});

describe('denseDailySeries', () => {
	it('zero-fills a window ending on the UTC day of `now`, oldest first', () => {
		const now = MIDNIGHT + 5 * 60 * 60 * 1000;
		const counts = new Map([
			[utcDayKey(now), 2],
			[utcDayKey(now - 2 * DAY), 7],
		]);
		expect(denseDailySeries(counts, 4, now)).toEqual([
			{ date: '2026-08-31', count: 0 },
			{ date: '2026-09-01', count: 7 },
			{ date: '2026-09-02', count: 0 },
			{ date: '2026-09-03', count: 2 },
		]);
	});

	it('ignores keys outside the window', () => {
		const counts = new Map([
			['2026-08-01', 5],
			['2026-09-04', 9],
		]);
		const series = denseDailySeries(counts, 3, MIDNIGHT);
		expect(series.map((d) => d.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
		expect(series.every((d) => d.count === 0)).toBe(true);
	});

	it('returns an empty series for a zero-day window', () => {
		expect(denseDailySeries(new Map(), 0, MIDNIGHT)).toEqual([]);
	});
});

describe('resolveNow', () => {
	it('keeps a finite caller clock', () => {
		expect(resolveNow(MIDNIGHT)).toBe(MIDNIGHT);
	});

	it('falls back to the real clock when absent or non-finite', () => {
		const before = Date.now();
		for (const candidate of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
			const now = resolveNow(candidate);
			expect(now).toBeGreaterThanOrEqual(before);
			expect(Number.isFinite(now)).toBe(true);
		}
	});
});
