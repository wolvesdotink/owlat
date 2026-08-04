import { describe, expect, it, vi } from 'vitest';
import { ENGAGEMENT_BAND_CUTS } from '@owlat/shared/engagementBands';
import {
	PRIORITY_BANDS,
	mapToPriority,
	priorityLabel,
	priorityToOrderMs,
} from '../engagementPriority.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('mapToPriority', () => {
	it.each([
		[100, PRIORITY_BANDS.HIGH],
		[80, PRIORITY_BANDS.HIGH],
		[79, PRIORITY_BANDS.MEDIUM],
		[50, PRIORITY_BANDS.MEDIUM],
		[49, PRIORITY_BANDS.LOW],
		[20, PRIORITY_BANDS.LOW],
		[19, PRIORITY_BANDS.COLD],
		[0, PRIORITY_BANDS.COLD],
	])('score %d → priority %d', (score, expected) => {
		expect(mapToPriority(score)).toBe(expected);
	});

	it('returns DEFAULT (3) for undefined', () => {
		expect(mapToPriority(undefined)).toBe(PRIORITY_BANDS.DEFAULT);
	});

	it('cuts at the SHARED band definition, not a hand-copied literal', () => {
		// The producer (`apps/api/convex/analytics/engagementScore.ts`) calibrates
		// its 0-100 curve against exactly these numbers. Both sides import
		// `@owlat/shared/engagementBands`, so moving a cut moves both — and this
		// case fails if someone re-inlines a literal here.
		expect(ENGAGEMENT_BAND_CUTS).toEqual({ high: 80, medium: 50, low: 20 });
		expect(mapToPriority(ENGAGEMENT_BAND_CUTS.high)).toBe(PRIORITY_BANDS.HIGH);
		expect(mapToPriority(ENGAGEMENT_BAND_CUTS.high - 1)).toBe(PRIORITY_BANDS.MEDIUM);
		expect(mapToPriority(ENGAGEMENT_BAND_CUTS.medium)).toBe(PRIORITY_BANDS.MEDIUM);
		expect(mapToPriority(ENGAGEMENT_BAND_CUTS.medium - 1)).toBe(PRIORITY_BANDS.LOW);
		expect(mapToPriority(ENGAGEMENT_BAND_CUTS.low)).toBe(PRIORITY_BANDS.LOW);
		expect(mapToPriority(ENGAGEMENT_BAND_CUTS.low - 1)).toBe(PRIORITY_BANDS.COLD);
	});
});

describe('priorityLabel', () => {
	it.each([
		[1, 'high-engagement'],
		[2, 'medium-engagement'],
		[3, 'low-engagement'],
		[4, 'cold'],
	])('priority %d → %s', (priority, expected) => {
		expect(priorityLabel(priority)).toBe(expected);
	});

	it('returns "unknown" for unrecognized priority', () => {
		expect(priorityLabel(5)).toBe('unknown');
	});
});

describe('priorityToOrderMs', () => {
	it.each([PRIORITY_BANDS.HIGH, PRIORITY_BANDS.MEDIUM, PRIORITY_BANDS.LOW])(
		'preserves priority %d as a far-past order value',
		(priority) => {
			expect(priorityToOrderMs(priority)).toBe(priority);
		}
	);

	it('uses the current time for cold recipients', () => {
		vi.spyOn(Date, 'now').mockReturnValue(42_000);
		expect(priorityToOrderMs(PRIORITY_BANDS.COLD)).toBe(42_000);
	});
});
