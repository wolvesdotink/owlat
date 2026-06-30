import { describe, expect, it, vi } from 'vitest';
import { PRIORITY_BANDS, mapToPriority, priorityLabel } from '../engagementPriority.js';

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
