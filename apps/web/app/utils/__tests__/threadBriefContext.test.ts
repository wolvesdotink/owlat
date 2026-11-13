import { describe, expect, it } from 'vitest';
import { isBriefDueUrgent } from '../threadBriefContext';

describe('isBriefDueUrgent', () => {
	const now = new Date(2026, 10, 13, 9, 30).getTime();

	it('marks a date that has passed', () => {
		expect(isBriefDueUrgent(new Date(2026, 10, 12, 17, 0).getTime(), now)).toBe(true);
	});

	it('marks a date later today', () => {
		expect(isBriefDueUrgent(new Date(2026, 10, 13, 23, 0).getTime(), now)).toBe(true);
	});

	it('leaves a date from tomorrow on as plain metadata', () => {
		expect(isBriefDueUrgent(new Date(2026, 10, 14, 0, 0).getTime(), now)).toBe(false);
		expect(isBriefDueUrgent(new Date(2026, 10, 20, 9, 0).getTime(), now)).toBe(false);
	});
});
