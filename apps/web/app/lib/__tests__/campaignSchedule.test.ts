import { describe, expect, it } from 'vitest';
import { parseScheduledStart } from '../campaignSchedule';

/**
 * The schedule start is derived once and read by three sites — the mutation
 * args, the pre-submit validation and the capacity preview. These fixtures are
 * what stops the three from drifting apart: any future change to the parse
 * (flooring to the minute, UTC interpretation, honouring the per-recipient
 * timezone toggle) has to move this table, and therefore moves all three sites
 * together.
 */
describe('parseScheduledStart', () => {
	const now = new Date('2026-03-10T12:00:00').getTime();
	const future = new Date('2026-03-11T09:30:00').getTime();

	const cases: ReadonlyArray<{
		name: string;
		date: string;
		time: string;
		expected: number | null;
	}> = [
		{ name: 'a future date and time', date: '2026-03-11', time: '09:30', expected: future },
		{ name: 'no date chosen', date: '', time: '09:30', expected: null },
		{ name: 'no time chosen', date: '2026-03-11', time: '', expected: null },
		{ name: 'neither chosen', date: '', time: '', expected: null },
		{ name: 'a date in the past', date: '2026-03-09', time: '09:30', expected: null },
		{
			name: 'exactly now (not strictly future)',
			date: '2026-03-10',
			time: '12:00',
			expected: null,
		},
		{ name: 'one minute after now', date: '2026-03-10', time: '12:01', expected: now + 60_000 },
		{ name: 'an unparseable date', date: 'not-a-date', time: '09:30', expected: null },
		{ name: 'an unparseable time', date: '2026-03-11', time: '99:99', expected: null },
		{ name: 'a garbage pair', date: '2026-13-45', time: '25:61', expected: null },
	];

	for (const { name, date, time, expected } of cases) {
		it(`returns ${expected === null ? 'null' : 'the instant'} for ${name}`, () => {
			expect(parseScheduledStart(date, time, now)).toBe(expected);
		});
	}

	it('judges the past against the injected clock, never the real one', () => {
		// Same inputs, two clocks: the only thing that decides is the parameter.
		expect(parseScheduledStart('2026-03-11', '09:30', future + 1)).toBeNull();
		expect(parseScheduledStart('2026-03-11', '09:30', future - 1)).toBe(future);
	});

	it('tolerates a non-finite clock without returning a start', () => {
		expect(parseScheduledStart('2026-03-11', '09:30', Number.NaN)).toBeNull();
	});
});
