import { describe, expect, it } from 'vitest';
import {
	compareRfc3339,
	isBase64,
	isBase64OfLength,
	isBoundedText,
	isChronological,
	isCount,
	isEd25519Key,
	isFqdn,
	isIpv4,
	isIpv6,
	isRecord,
	isRfc3339,
	isSha256Hex,
	unknownKeys,
} from '../fields.js';

describe('isRecord', () => {
	it.each([[{}], [{ a: 1 }], [Object.create(null)]])('accepts %p', (value) => {
		expect(isRecord(value)).toBe(true);
	});

	it.each([[null], [undefined], [[]], ['{}'], [1], [true]])('rejects %p', (value) => {
		expect(isRecord(value)).toBe(false);
	});
});

describe('isCount', () => {
	it.each([[0], [1], [Number.MAX_SAFE_INTEGER]])('accepts %p', (value) => {
		expect(isCount(value)).toBe(true);
	});

	it.each([
		[-1],
		[0.5],
		[Number.NaN],
		[Number.POSITIVE_INFINITY],
		[Number.MAX_SAFE_INTEGER + 2],
		['1'],
		[null],
		[undefined],
	])('rejects %p', (value) => {
		expect(isCount(value)).toBe(false);
	});
});

describe('unknownKeys', () => {
	it('returns the extras, sorted, so error lists are stable', () => {
		expect(unknownKeys({ z: 1, a: 2, b: 3 }, ['b'])).toEqual(['a', 'z']);
		expect(unknownKeys({ b: 3 }, ['a', 'b'])).toEqual([]);
	});
});

describe('isFqdn', () => {
	it.each([
		'example.com',
		'mx.hinterland.camp',
		'a.co',
		'mx-1.example.com',
		'0.example.com',
		`${'a'.repeat(63)}.example.com`,
	])('accepts %s', (value) => {
		expect(isFqdn(value)).toBe(true);
	});

	it.each([
		'Example.com',
		'example.com.',
		'.example.com',
		'example..com',
		'example',
		'',
		'-x.example.com',
		'x-.example.com',
		'ex ample.com',
		'192.0.2.7',
		'example.7',
		'example.c',
		`${'a'.repeat(64)}.com`,
		`${'a.'.repeat(130)}com`,
	])('rejects %s', (value) => {
		expect(isFqdn(value)).toBe(false);
	});

	it.each([[null], [undefined], [7], [['example.com']]])('rejects the non-string %p', (value) => {
		expect(isFqdn(value)).toBe(false);
	});
});

describe('isIpv4', () => {
	it.each(['0.0.0.0', '192.0.2.7', '255.255.255.255'])('accepts %s', (value) => {
		expect(isIpv4(value)).toBe(true);
	});

	it.each([
		'192.0.2.256',
		'010.0.0.1',
		'1.2.3',
		'1.2.3.4.5',
		'1.2.3.-4',
		'192.0.2.7 ',
		'192.0.2.7/32',
		'0x7f.0.0.1',
		'',
	])('rejects %s', (value) => {
		expect(isIpv4(value)).toBe(false);
	});
});

describe('isIpv6', () => {
	it.each([
		'::',
		'::1',
		'2001:db8::1',
		'fe80::1',
		'2001:db8:0:1:1:1:1:1',
		'1:2:3:4:5:6:7:8',
		'::ffff:192.0.2.7',
		'64:ff9b::c000:207',
	])('accepts the canonical form %s', (value) => {
		expect(isIpv6(value)).toBe(true);
	});

	// RFC 5952: one address, one spelling. Scoring keys a subject off the signed
	// string, so a second spelling is a second reputation history.
	it.each([
		['expanded zero groups', '2001:0db8:0000:0000:0000:0000:0000:0001'],
		['uncompressed zero groups', '0:0:0:0:0:0:0:1'],
		['a leading zero in a group', '2001:0db8::1'],
		['a `::` compressing a single group', '2001:db8:0:1:1:1:1::'],
		['a `::` compressing a single trailing group', '1:2:3:4:5:6:7::'],
		['a second, shorter `::` candidate compressed instead', '2001:db8:0:0:1:0:0:1'],
		['a dotted quad outside the IPv4-mapped prefix', '64:ff9b::192.0.2.7'],
		['the hex form of an IPv4-mapped address', '::ffff:c000:207'],
		['uppercase hex', '2001:DB8::1'],
	])('rejects %s (%s)', (_label, value) => {
		expect(isIpv6(value)).toBe(false);
	});

	it.each([
		'2001::db8::1',
		'2001:db8:0:0:0:0:0:0:1',
		'2001:db8:0:0:0:0:0',
		'2001:db8::12345',
		'2001:db8::zzzz',
		':2001:db8::1',
		'2001:db8::1:',
		'::ffff:192.0.2.256',
		'1.2.3.4::',
		'192.0.2.7',
		'',
	])('rejects the malformed %s', (value) => {
		expect(isIpv6(value)).toBe(false);
	});

	it('leaves exactly one accepted spelling per address', () => {
		for (const spellings of [
			['::1', '0:0:0:0:0:0:0:1', '::0001', '0::1'],
			['2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8:0:0:0:0:0:1'],
			['::ffff:192.0.2.7', '::ffff:c000:207', '0:0:0:0:0:ffff:192.0.2.7'],
		]) {
			expect(spellings.filter((value) => isIpv6(value))).toEqual([spellings[0]]);
		}
	});
});

describe('isRfc3339', () => {
	it.each([
		'2026-08-19T00:00:00Z',
		'2026-08-19T00:00:00.1Z',
		'2026-08-19T00:00:00.123Z',
		'2024-02-29T12:00:00Z',
		'2000-02-29T12:00:00Z',
	])('accepts %s', (value) => {
		expect(isRfc3339(value)).toBe(true);
	});

	// One instant, one spelling: everything below denotes a moment that is
	// already expressible in the accepted form.
	it.each([
		['lowercase designators', '2026-08-19t00:00:00z'],
		['a positive numeric offset', '2026-08-19T02:00:00+02:00'],
		['a negative numeric offset', '2026-08-19T00:00:00-05:30'],
		['a zero numeric offset', '2026-08-19T00:00:00+00:00'],
		['sub-millisecond precision', '2026-08-19T00:00:00.123456Z'],
		['absurd precision', '2026-08-19T00:00:00.0000000000000001Z'],
	])('rejects the non-canonical %s (%s)', (_label, value) => {
		expect(isRfc3339(value)).toBe(false);
	});

	it.each([
		'2026-08-19',
		'2026-08-19T00:00:00',
		'2026-08-19 00:00:00Z',
		'2026-02-30T00:00:00Z',
		'2026-02-29T00:00:00Z',
		'1900-02-29T00:00:00Z',
		'2026-13-01T00:00:00Z',
		'2026-00-01T00:00:00Z',
		'2026-08-00T00:00:00Z',
		'2026-08-19T24:00:00Z',
		'2026-08-19T00:60:00Z',
		'2026-08-19T23:59:60Z',
		'2026-08-19T00:00:00.Z',
		'20260819T000000Z',
		'',
	])('rejects %s', (value) => {
		expect(isRfc3339(value)).toBe(false);
	});

	it.each([[1755561600000], [null], [new Date(0)]])('rejects the non-string %p', (value) => {
		expect(isRfc3339(value)).toBe(false);
	});

	it('agrees with a lexical sort for equal precision', () => {
		const sorted = ['2026-08-19T00:00:00Z', '2026-08-19T00:00:01Z', '2026-08-20T00:00:00Z'];
		expect([...sorted].reverse().sort()).toEqual(sorted);
		expect(sorted.every((value) => isRfc3339(value))).toBe(true);
	});
});

describe('compareRfc3339', () => {
	it('orders instants', () => {
		expect(compareRfc3339('2026-08-19T00:00:00Z', '2026-08-20T00:00:00Z')).toBe(-1);
		expect(compareRfc3339('2026-08-20T00:00:00Z', '2026-08-19T00:00:00Z')).toBe(1);
		expect(compareRfc3339('2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z')).toBe(0);
	});

	it('disagrees with a lexical compare across fractional precision', () => {
		const early = '2026-08-19T00:00:00Z';
		const late = '2026-08-19T00:00:00.500Z';
		expect(late < early).toBe(true);
		expect(compareRfc3339(early, late)).toBe(-1);
	});

	it('sorts non-timestamps after every timestamp instead of throwing', () => {
		expect(compareRfc3339('yesterday', '2026-08-19T00:00:00Z')).toBe(1);
		expect(compareRfc3339('2026-08-19T00:00:00Z', undefined)).toBe(-1);
		expect(compareRfc3339(null, 7)).toBe(0);
	});
});

describe('isChronological', () => {
	it('accepts equal and increasing instants', () => {
		expect(isChronological('2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z')).toBe(true);
		expect(isChronological('2026-08-19T00:00:00Z', '2026-08-20T00:00:00Z')).toBe(true);
	});

	it('rejects a decreasing pair', () => {
		expect(isChronological('2026-08-20T00:00:00Z', '2026-08-19T23:59:59Z')).toBe(false);
	});

	it('compares as instants, not as strings', () => {
		// Lexically the later string, chronologically the earlier instant.
		expect(isChronological('2026-08-19T00:00:00.500Z', '2026-08-19T00:00:00Z')).toBe(false);
		expect(isChronological('2026-08-19T00:00:00Z', '2026-08-19T00:00:00.500Z')).toBe(true);
	});

	it('rejects an instant spelled with an offset instead of Z', () => {
		expect(isChronological('2026-08-19T23:00:00Z', '2026-08-20T01:30:00+02:00')).toBe(false);
	});

	it('rejects when either side is not a timestamp', () => {
		expect(isChronological('yesterday', '2026-08-19T00:00:00Z')).toBe(false);
		expect(isChronological('2026-08-19T00:00:00Z', undefined)).toBe(false);
	});
});

describe('base64 and digest predicates', () => {
	it('accepts canonical base64 only', () => {
		expect(isBase64('AAAA')).toBe(true);
		expect(isBase64(Buffer.from('hi').toString('base64'))).toBe(true);
		expect(isBase64('AAA')).toBe(false);
		expect(isBase64('AA A=')).toBe(false);
		expect(isBase64('AA-_')).toBe(false);
		expect(isBase64('')).toBe(false);
	});

	it('rejects base64 with non-zero bits past the declared length', () => {
		// 'AB==' and 'AA==' both decode to one byte; only one is canonical.
		expect(isBase64('AB==')).toBe(false);
		expect(isBase64('AA==')).toBe(true);
	});

	it('measures the decoded length', () => {
		expect(isBase64OfLength(Buffer.alloc(64).toString('base64'), 64)).toBe(true);
		expect(isBase64OfLength(Buffer.alloc(63).toString('base64'), 64)).toBe(false);
		expect(isEd25519Key(Buffer.alloc(32).toString('base64'))).toBe(true);
		expect(isEd25519Key(Buffer.alloc(33).toString('base64'))).toBe(false);
	});

	it('accepts lowercase 64-character hex as a sha256 digest', () => {
		expect(isSha256Hex('a'.repeat(64))).toBe(true);
		expect(isSha256Hex('A'.repeat(64))).toBe(false);
		expect(isSha256Hex('a'.repeat(63))).toBe(false);
		expect(isSha256Hex(`0x${'a'.repeat(64)}`)).toBe(false);
	});
});

describe('isBoundedText', () => {
	it('accepts printable text within the cap', () => {
		expect(isBoundedText('a statement', 32)).toBe(true);
		expect(isBoundedText('with\ttabs\nand newlines', 32)).toBe(true);
		expect(isBoundedText('unicode é 🚀', 32)).toBe(true);
	});

	it('rejects blank, oversized, control-bearing and non-string values', () => {
		expect(isBoundedText('', 32)).toBe(false);
		expect(isBoundedText('   \n ', 32)).toBe(false);
		expect(isBoundedText('x'.repeat(33), 32)).toBe(false);
		expect(isBoundedText(`x${String.fromCharCode(0)}`, 32)).toBe(false);
		expect(isBoundedText(`x${String.fromCharCode(0x1b)}[31m`, 32)).toBe(false);
		expect(isBoundedText(`x${String.fromCharCode(0x7f)}`, 32)).toBe(false);
		expect(isBoundedText(42, 32)).toBe(false);
	});
});
