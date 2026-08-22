import { describe, expect, it } from 'vitest';
import { canonicalIp, normalizeDomainName, subjectKey, subjectLookupKeys } from '../subject.js';

describe('normalizeDomainName', () => {
	it.each([
		['Example.COM', 'example.com'],
		['example.com.', 'example.com'],
		['  example.com..  ', 'example.com'],
	])('normalizes %p to %p', (input, expected) => {
		expect(normalizeDomainName(input)).toBe(expected);
	});

	it.each([undefined, '', '   ', '.', '...'])('has no name for %p', (input) => {
		expect(normalizeDomainName(input)).toBeNull();
	});

	it.each([
		['a space', 'a b.example'],
		['a newline', 'evil.example\nsecond.example'],
		['a NUL', 'evil.example\u0000'],
		['a tab', 'evil\texample.com'],
		['a leading dot', '.example.com'],
		['an empty label', 'a..example'],
		['a slash', 'example.com/path'],
		['an @', 'user@example.com'],
	])('refuses to turn %s into a query name (%p)', (_label, input) => {
		expect(normalizeDomainName(input)).toBeNull();
	});

	it('refuses a name longer than 253 bytes, or a label longer than 63', () => {
		// 299 bytes of perfectly legal labels: length is its own limit.
		expect(normalizeDomainName(Array.from({ length: 60 }, () => 'abcd').join('.'))).toBeNull();
		expect(normalizeDomainName(`${'x'.repeat(300)}.example`)).toBeNull();
		expect(normalizeDomainName(`${'x'.repeat(64)}.example`)).toBeNull();
		expect(normalizeDomainName(`${'x'.repeat(63)}.example`)).not.toBeNull();
	});

	it('keeps the names OSTR itself uses: punycode and underscore labels', () => {
		expect(normalizeDomainName('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
		expect(normalizeDomainName('_ostr.example.com')).toBe('_ostr.example.com');
	});
});

describe('canonicalIp', () => {
	it('gives every spelling of one address the same key', () => {
		const key = canonicalIp('2001:db8::1')?.key;
		expect(canonicalIp('2001:0DB8:0000:0000:0000:0000:0000:0001')?.key).toBe(key);
		expect(canonicalIp(' 2001:db8:0:0:0:0:0:1 ')?.key).toBe(key);
	});

	it('keeps two different addresses apart', () => {
		expect(canonicalIp('192.0.2.7')?.key).not.toBe(canonicalIp('192.0.2.8')?.key);
	});

	it.each([undefined, '', '  ', 'nonsense', '256.0.0.1', '192.0.2.7/32', '2001:db8::1::2'])(
		'has no key for %p',
		(input) => {
			expect(canonicalIp(input)).toBeNull();
		}
	);
});

describe('subject keys', () => {
	it('keeps a domain, a bare IP and the pair apart (plan D2)', () => {
		const keys = new Set([
			subjectKey({ domain: 'example.com' }),
			subjectKey({ ip: '192.0.2.7' }),
			subjectKey({ domain: 'example.com', ip: '192.0.2.7' }),
		]);
		expect(keys.size).toBe(3);
	});

	it('is null for a reference that names nothing scoreable', () => {
		expect(subjectKey({})).toBeNull();
		expect(subjectKey({ domain: '  ' })).toBeNull();
		expect(subjectKey({ ip: 'nope' })).toBeNull();
	});

	it('falls back from the pair to the domain and then the bare IP', () => {
		expect(subjectLookupKeys({ domain: 'example.com', ip: '192.0.2.7' })).toEqual([
			subjectKey({ domain: 'example.com', ip: '192.0.2.7' }),
			subjectKey({ domain: 'example.com' }),
			subjectKey({ ip: '192.0.2.7' }),
		]);
	});

	it('ignores an unparseable IP alongside a usable domain', () => {
		expect(subjectLookupKeys({ domain: 'example.com', ip: 'nonsense' })).toEqual([
			subjectKey({ domain: 'example.com' }),
		]);
	});
});
