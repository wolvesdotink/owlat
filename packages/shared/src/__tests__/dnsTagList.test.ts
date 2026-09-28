import { describe, expect, it } from 'vitest';
import { parseStrictTagList, parseTagList, stripTagValueWhitespace } from '../dnsTagList';

const KEY_RECORD = { lowercaseName: true, normalizeValue: stripTagValueWhitespace } as const;
const STRICT_CASE_SENSITIVE = {
	lowercaseName: false,
	normalizeValue: stripTagValueWhitespace,
} as const;

describe('stripTagValueWhitespace', () => {
	it('removes every space, tab, CR and LF, including folded runs', () => {
		expect(stripTagValueWhitespace(' MIIB IjAN\t\r\n Bgkq ')).toBe('MIIBIjANBgkq');
		expect(stripTagValueWhitespace('sha1 : sha256')).toBe('sha1:sha256');
	});
});

describe('parseTagList', () => {
	it('lowercases names when asked and normalizes values', () => {
		const tags = parseTagList('V=DKIM1; K=rsa; p=AB CD', KEY_RECORD);
		expect([...tags]).toEqual([
			['v', 'DKIM1'],
			['k', 'rsa'],
			['p', 'ABCD'],
		]);
	});

	it('keeps the first of two duplicate tags', () => {
		expect(parseTagList('p=AB; p=ZZ', KEY_RECORD).get('p')).toBe('AB');
	});

	it('ignores empty segments, segments without = and empty names', () => {
		const tags = parseTagList(';; junk; =x; k=rsa;', KEY_RECORD);
		expect([...tags]).toEqual([['k', 'rsa']]);
	});
});

describe('parseStrictTagList', () => {
	it('parses a well-formed list in record order, allowing one trailing ;', () => {
		const tags = parseStrictTagList('v=DKIM1; k=rsa; p=AB CD; \t', STRICT_CASE_SENSITIVE);
		expect(tags && [...tags]).toEqual([
			['v', 'DKIM1'],
			['k', 'rsa'],
			['p', 'ABCD'],
		]);
	});

	it('rejects a duplicate tag instead of picking one', () => {
		expect(parseStrictTagList('v=DKIM1; p=AB; p=ZZ', STRICT_CASE_SENSITIVE)).toBeNull();
	});

	it('compares duplicate names after lowercasing when asked', () => {
		expect(parseStrictTagList('p=AB; P=ZZ', STRICT_CASE_SENSITIVE)?.size).toBe(2);
		expect(parseStrictTagList('p=AB; P=ZZ', KEY_RECORD)).toBeNull();
	});

	it.each([
		['an empty input', ''],
		['a lone separator', ';'],
		['a leading empty segment', '; p=AB'],
		['an inner empty segment', 'k=rsa;; p=AB'],
		['two trailing separators', 'p=AB;;'],
		['a segment without =', 'k=rsa; junk; p=AB'],
		['an empty name', 'k=rsa; =x; p=AB'],
		['a name that is not an RFC 6376 tag-name', 'k=rsa; 1x=y; p=AB'],
	])('rejects %s', (_label, input) => {
		expect(parseStrictTagList(input, STRICT_CASE_SENSITIVE)).toBeNull();
	});
});
