import { describe, it, expect } from 'vitest';
import { formatContactPropertyValue } from '../contactPropertyValue';

const format = {
	yes: 'Yes',
	no: 'No',
	date: (value: Date) =>
		new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(
			value
		),
};

describe('formatContactPropertyValue', () => {
	it('reads a yes/no property as Yes or No, not true or false', () => {
		expect(formatContactPropertyValue('boolean', 'true', format)).toBe('Yes');
		expect(formatContactPropertyValue('boolean', 'false', format)).toBe('No');
	});

	it('formats a stored calendar day with the locale and keeps the day', () => {
		expect(formatContactPropertyValue('date', '2026-11-09', format)).toBe('Nov 9, 2026');
	});

	it('formats a timestamp-valued date', () => {
		const stamp = String(new Date(2026, 0, 23, 12).getTime());
		expect(formatContactPropertyValue('date', stamp, format)).toBe('Jan 23, 2026');
	});

	it('leaves a value it cannot read untouched', () => {
		expect(formatContactPropertyValue('date', 'soon', format)).toBe('soon');
		expect(formatContactPropertyValue('boolean', 'maybe', format)).toBe('maybe');
		expect(formatContactPropertyValue('string', 'Berlin', format)).toBe('Berlin');
		expect(formatContactPropertyValue('number', '42', format)).toBe('42');
	});

	it('returns null for an empty value so the page can say "Not set"', () => {
		expect(formatContactPropertyValue('string', '', format)).toBeNull();
		expect(formatContactPropertyValue('boolean', null, format)).toBeNull();
		expect(formatContactPropertyValue('date', undefined, format)).toBeNull();
	});
});
