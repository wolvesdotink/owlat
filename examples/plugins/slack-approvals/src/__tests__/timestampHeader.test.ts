import { describe, expect, it } from 'vitest';
import { parseUnixSecondsHeader } from '../timestampHeader';

describe('parseUnixSecondsHeader', () => {
	// One table both authentication surfaces (Slack + Owlat hook) now agree on,
	// so a future edit that diverges the grammar fails here.
	it.each([
		['a run of digits', '1700000000', 1_700_000_000],
		['leading zeros', '01', 1],
		['surrounding whitespace', ' 12 ', 12],
		['zero', '0', 0],
	])('parses %s', (_label, input, expected) => {
		expect(parseUnixSecondsHeader(input)).toBe(expected);
	});

	it.each([
		['a negative timestamp (no sign accepted)', '-1'],
		['exponential notation', '1e3'],
		['a fractional value', '1.5'],
		['an empty string', ''],
		['whitespace only', '   '],
		['non-numeric text', 'not-a-number'],
		['null', null],
		['undefined', undefined],
	])('rejects %s as null', (_label, input) => {
		expect(parseUnixSecondsHeader(input)).toBeNull();
	});

	it('rejects a value beyond the safe-integer range', () => {
		expect(parseUnixSecondsHeader('99999999999999999999')).toBeNull();
	});
});
