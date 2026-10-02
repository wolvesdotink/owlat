import { describe, expect, it } from 'vitest';
import {
	addHistograms,
	CONTACT_MIN_EVIDENCE,
	decayHistogramTo,
	effectiveTimeZone,
	emptyHistogram,
	evidenceAt,
	foldEngagement,
	isWellFormedHistogram,
	peakHour,
	SEND_TIME_HALF_LIFE_DAYS,
	slotScorer,
	type SendTimeEngagement,
	type SendTimeHistogram,
} from '../sendTimeProfile';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1, 9, 0);

function fold(events: SendTimeEngagement[]): SendTimeHistogram {
	return events.reduce<SendTimeHistogram | null>((h, e) => foldEngagement(h, e), null)!;
}

function close(a: number[], b: number[]) {
	expect(a).toHaveLength(b.length);
	for (const [i, x] of a.entries()) expect(x).toBeCloseTo(b[i]!, 9);
}

describe('send-time profile', () => {
	it('starts a histogram at the first event and weighs clicks double', () => {
		const h = fold([
			{ at: T0, kind: 'open', hour: 9, weekday: 2 },
			{ at: T0, kind: 'click', hour: 9, weekday: 2 },
		]);
		expect(h.asOf).toBe(T0);
		expect(h.hours[9]).toBe(3);
		expect(h.days[2]).toBe(3);
		expect(h.total).toBe(3);
		expect(isWellFormedHistogram(h)).toBe(true);
	});

	it('halves an event every half-life', () => {
		const h = fold([{ at: T0, kind: 'open', hour: 9, weekday: 2 }]);
		const later = decayHistogramTo(h, T0 + SEND_TIME_HALF_LIFE_DAYS * DAY);
		expect(later.hours[9]).toBeCloseTo(0.5, 9);
		expect(evidenceAt(h, T0 + 2 * SEND_TIME_HALF_LIFE_DAYS * DAY)).toBeCloseTo(0.25, 9);
		// Never decays backwards.
		expect(decayHistogramTo(h, T0 - DAY)).toBe(h);
	});

	it('gives the same histogram whatever order the events arrive in', () => {
		const events: SendTimeEngagement[] = [
			{ at: T0, kind: 'open', hour: 8, weekday: 1 },
			{ at: T0 + 3 * DAY, kind: 'click', hour: 20, weekday: 4 },
			{ at: T0 + 10 * DAY, kind: 'open', hour: 9, weekday: 4 },
		];
		const inOrder = fold(events);
		const outOfOrder = fold([events[2]!, events[0]!, events[1]!]);
		expect(outOfOrder.asOf).toBe(inOrder.asOf);
		close(outOfOrder.hours, inOrder.hours);
		close(outOfOrder.days, inOrder.days);
		expect(outOfOrder.total).toBeCloseTo(inOrder.total, 9);
	});

	it('lets a new habit take over as the old one decays', () => {
		const old = Array.from({ length: 6 }, (_, i) => ({
			at: T0 + i * DAY,
			kind: 'open' as const,
			hour: 12,
			weekday: 1,
		}));
		const recent = Array.from({ length: 4 }, (_, i) => ({
			at: T0 + 200 * DAY + i * DAY,
			kind: 'open' as const,
			hour: 19,
			weekday: 1,
		}));
		expect(peakHour(fold(old))).toBe(12);
		expect(peakHour(fold([...old, ...recent]))).toBe(19);
	});

	it('adds histograms at a common instant (the organization shards)', () => {
		const a = fold([{ at: T0, kind: 'open', hour: 9, weekday: 2 }]);
		const b = fold([
			{ at: T0 + SEND_TIME_HALF_LIFE_DAYS * DAY, kind: 'open', hour: 9, weekday: 2 },
		]);
		const sum = addHistograms(a, b);
		expect(sum.asOf).toBe(b.asOf);
		expect(sum.hours[9]).toBeCloseTo(1.5, 9);
		expect(sum.total).toBeCloseTo(1.5, 9);
	});

	it('smooths the hour histogram so a cluster beats a stray hour', () => {
		const h = fold([
			{ at: T0, kind: 'open', hour: 8, weekday: 1 },
			{ at: T0, kind: 'open', hour: 9, weekday: 1 },
			{ at: T0, kind: 'open', hour: 10, weekday: 1 },
			{ at: T0, kind: 'click', hour: 22, weekday: 1 },
		]);
		expect(peakHour(h)).toBe(9);
		expect(peakHour(emptyHistogram(T0))).toBeNull();
	});

	it('tilts towards the weekday the contact reads on without ruling out the others', () => {
		const h = fold([
			{ at: T0, kind: 'open', hour: 9, weekday: 2 },
			{ at: T0, kind: 'open', hour: 9, weekday: 2 },
			{ at: T0, kind: 'open', hour: 9, weekday: 2 },
		]);
		const score = slotScorer(h);
		expect(score(9, 2)).toBeGreaterThan(score(9, 5));
		expect(score(9, 5)).toBeGreaterThan(0);
	});

	it('treats a malformed stored histogram as empty', () => {
		const broken = { hours: [1, 2], days: [], total: 3, asOf: T0 } as SendTimeHistogram;
		expect(isWellFormedHistogram(broken)).toBe(false);
		expect(evidenceAt(broken, T0)).toBe(0);
		const h = foldEngagement(broken, { at: T0, kind: 'open', hour: 7, weekday: 3 });
		expect(h.total).toBe(1);
		expect(h.hours).toHaveLength(24);
	});

	it('keeps a hostile hour or weekday inside the histogram', () => {
		const h = foldEngagement(null, { at: T0, kind: 'open', hour: 25, weekday: -1 });
		expect(h.hours[1]).toBe(1);
		expect(h.days[6]).toBe(1);
	});

	it('needs a few recent engagements before a profile counts as evidence', () => {
		const two = fold([
			{ at: T0, kind: 'open', hour: 9, weekday: 2 },
			{ at: T0, kind: 'open', hour: 9, weekday: 2 },
		]);
		expect(evidenceAt(two, T0)).toBeLessThan(CONTACT_MIN_EVIDENCE);
		const withClick = foldEngagement(two, { at: T0, kind: 'click', hour: 9, weekday: 2 });
		expect(evidenceAt(withClick, T0)).toBeGreaterThanOrEqual(CONTACT_MIN_EVIDENCE);
	});

	it('falls back from the contact zone to the organization zone to UTC', () => {
		expect(effectiveTimeZone('Europe/Berlin', 'America/New_York')).toBe('Europe/Berlin');
		expect(effectiveTimeZone('Not/AZone', 'America/New_York')).toBe('America/New_York');
		expect(effectiveTimeZone(undefined, undefined)).toBe('UTC');
	});
});
