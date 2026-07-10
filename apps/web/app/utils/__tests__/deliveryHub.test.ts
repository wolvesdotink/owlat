import { describe, expect, it } from 'vitest';
import { deliveryVerdict, warmupSentence, deliveryStatTiles } from '../deliveryHub';

describe('deliveryVerdict', () => {
	it('maps every roll-up level to a human label + tone', () => {
		expect(deliveryVerdict('ok')).toEqual({ label: 'Healthy', tone: 'ok' });
		expect(deliveryVerdict('warn')).toEqual({ label: 'At risk', tone: 'warn' });
		expect(deliveryVerdict('error')).toEqual({ label: 'Blocked', tone: 'error' });
	});
});

describe('warmupSentence', () => {
	it('returns null when there is no warming data', () => {
		expect(warmupSentence(null)).toBeNull();
	});

	it('reads fully warmed', () => {
		expect(warmupSentence({ phase: 'graduated', ips: [] })).toBe(
			'Fully warmed — sending at full volume.'
		);
	});

	it('reads paused', () => {
		expect(warmupSentence({ phase: 'plateau', ips: [] })).toMatch(/paused/i);
	});

	it('reports the furthest IP day as a percent of the 30-day warm-up', () => {
		expect(warmupSentence({ phase: 'ramp', ips: [{ currentDay: 15 }, { currentDay: 9 }] })).toBe(
			'Warming up — day 15 of 30 · 50% of full sending volume'
		);
	});

	it('handles a ramping phase with no IPs yet (day 0)', () => {
		expect(warmupSentence({ phase: 'ramp', ips: [] })).toBe(
			'Warming up — day 0 of 30 · 0% of full sending volume'
		);
	});
});

describe('deliveryStatTiles — threshold copy + tone', () => {
	it('writes the bounce/complaint thresholds next to each value', () => {
		const tiles = deliveryStatTiles({ bounceRate: 0.005, complaintRate: 0.0005 }, null);
		const bounce = tiles.find((t) => t.key === 'bounce')!;
		const complaint = tiles.find((t) => t.key === 'complaint')!;
		expect(bounce.threshold).toBe('limit 2%');
		expect(complaint.threshold).toBe('limit 0.1%');
		expect(bounce.tone).toBe('ok');
		expect(complaint.tone).toBe('ok');
	});

	it('shows an em-dash and stays ok-toned when there is no reputation data', () => {
		const tiles = deliveryStatTiles(null, null);
		expect(tiles.find((t) => t.key === 'bounce')!.value).toBe('—');
		expect(tiles.find((t) => t.key === 'complaint')!.value).toBe('—');
		expect(tiles.every((t) => t.tone === 'ok')).toBe(true);
	});

	it('warns at the medium threshold and errors at the high threshold', () => {
		// bounce 0.03 ≥ medium(0.02) but < high(0.05) → warn;
		// complaint 0.002 ≥ high(0.002) → error.
		const tiles = deliveryStatTiles({ bounceRate: 0.03, complaintRate: 0.002 }, null);
		expect(tiles.find((t) => t.key === 'bounce')!.tone).toBe('warn');
		expect(tiles.find((t) => t.key === 'complaint')!.tone).toBe('error');
	});

	it('shows remaining budget with the daily cap as its threshold', () => {
		const tiles = deliveryStatTiles(null, {
			totalSentToday: 100,
			totalDailyCap: 1000,
			remainingToday: 900,
		});
		const budget = tiles.find((t) => t.key === 'budget')!;
		expect(budget.value).toBe('900');
		expect(budget.threshold).toBe('cap 1,000');
		expect(budget.tone).toBe('ok');
	});

	it('errors the budget tile when nothing is left today', () => {
		const tiles = deliveryStatTiles(null, {
			totalSentToday: 1000,
			totalDailyCap: 1000,
			remainingToday: 0,
		});
		expect(tiles.find((t) => t.key === 'budget')!.tone).toBe('error');
	});

	it('falls back gracefully when warming has not synced', () => {
		const budget = deliveryStatTiles(null, null).find((t) => t.key === 'budget')!;
		expect(budget.value).toBe('—');
		expect(budget.threshold).toMatch(/not synced/i);
	});
});

describe('deliveryStatTiles — day-over-day delta', () => {
	it('shows no delta when there is no prior day to compare against', () => {
		const bounce = deliveryStatTiles({ bounceRate: 0.01, complaintRate: 0.001 }, null).find(
			(t) => t.key === 'bounce'
		)!;
		expect(bounce.delta).toBeUndefined();
		expect(bounce.deltaDirection).toBe('flat');
		expect(bounce.deltaTone).toBe('neutral');
	});

	it('reads a falling bounce rate as a positive (good) down-delta', () => {
		// bounce fell 0.02 → 0.01: glyph points down, tone is positive (green).
		const bounce = deliveryStatTiles({ bounceRate: 0.01, complaintRate: 0.001 }, null, {
			bounceRate: 0.02,
			complaintRate: 0.001,
		}).find((t) => t.key === 'bounce')!;
		expect(bounce.deltaDirection).toBe('down');
		expect(bounce.deltaTone).toBe('positive');
		expect(bounce.delta).toBe('1.00%');
	});

	it('reads a rising complaint rate as a negative (bad) up-delta', () => {
		const complaint = deliveryStatTiles({ bounceRate: 0.01, complaintRate: 0.003 }, null, {
			bounceRate: 0.01,
			complaintRate: 0.001,
		}).find((t) => t.key === 'complaint')!;
		expect(complaint.deltaDirection).toBe('up');
		expect(complaint.deltaTone).toBe('negative');
	});

	it('never draws a delta on the budget tile (no persisted history)', () => {
		const budget = deliveryStatTiles(
			{ bounceRate: 0.01, complaintRate: 0.001 },
			{ totalSentToday: 10, totalDailyCap: 100, remainingToday: 90 },
			{ bounceRate: 0.02, complaintRate: 0.002 }
		).find((t) => t.key === 'budget')!;
		expect(budget.delta).toBeUndefined();
		expect(budget.deltaDirection).toBe('flat');
	});
});
