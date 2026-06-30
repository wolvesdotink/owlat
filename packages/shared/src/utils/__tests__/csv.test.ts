import { describe, it, expect } from 'vitest';
import { sanitizeCsvCell } from '../csv';

describe('sanitizeCsvCell', () => {
	it.each([
		['=HYPERLINK("http://evil")', "'=HYPERLINK(\"http://evil\")"],
		['+1+1', "'+1+1"],
		['-2+3', "'-2+3"],
		['@SUM(A1)', "'@SUM(A1)"],
		['\t=cmd', "'\t=cmd"],
		['\r=cmd', "'\r=cmd"],
	])('neutralizes formula prefix %j', (input, expected) => {
		expect(sanitizeCsvCell(input)).toBe(expected);
	});

	it.each(['plain text', 'jane@example.com', '42', '', 'a=b', 'minus-inside-text'])(
		'leaves benign value %j untouched',
		(input) => {
			expect(sanitizeCsvCell(input)).toBe(input);
		},
	);
});
