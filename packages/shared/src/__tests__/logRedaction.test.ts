import { describe, it, expect } from 'vitest';
import {
	redactEmailAddress,
	redactEmailAddresses,
	redactSubject,
	redactionDigest,
} from '../logRedaction';

describe('redactEmailAddress', () => {
	it('keeps the domain and removes the local part', () => {
		const redacted = redactEmailAddress('marcel@example.com');
		expect(redacted).toMatch(/^redacted-[0-9a-f]{12}@example\.com$/);
		expect(redacted).not.toContain('marcel');
	});

	it('gives the same token for the same address so lines correlate across hops', () => {
		expect(redactEmailAddress('a@example.com')).toBe(redactEmailAddress('a@example.com'));
	});

	it('normalizes case and surrounding whitespace before hashing', () => {
		const canonical = redactEmailAddress('marcel@example.com');
		expect(redactEmailAddress('  Marcel@Example.COM ')).toBe(canonical);
	});

	it('gives different tokens to different addresses on the same domain', () => {
		expect(redactEmailAddress('a@example.com')).not.toBe(redactEmailAddress('b@example.com'));
	});

	it('gives different tokens to the same local part on different domains', () => {
		expect(redactEmailAddress('a@example.com')).not.toBe(redactEmailAddress('a@example.net'));
	});

	it('handles subdomains and plus-tags without leaking either', () => {
		const redacted = redactEmailAddress('marcel+invoices@mail.example.co.uk');
		expect(redacted).toMatch(/^redacted-[0-9a-f]{12}@mail\.example\.co\.uk$/);
		expect(redacted).not.toContain('invoices');
	});

	it('splits on the last @ so a quoted local part cannot smuggle text into the domain', () => {
		expect(redactEmailAddress('"we@ird"@example.com')).toMatch(
			/^redacted-[0-9a-f]{12}@example\.com$/
		);
	});

	it('returns a bare token for a value that is not an address', () => {
		expect(redactEmailAddress('not-an-address')).toMatch(/^redacted-[0-9a-f]{12}$/);
		expect(redactEmailAddress('trailing@')).toMatch(/^redacted-[0-9a-f]{12}$/);
		expect(redactEmailAddress('@nolocal.example')).toMatch(/^redacted-[0-9a-f]{12}$/);
	});

	it('passes the empty string through rather than hashing nothing', () => {
		expect(redactEmailAddress('')).toBe('');
		expect(redactEmailAddress('   ')).toBe('');
	});
});

describe('redactEmailAddresses', () => {
	it('preserves order and length', () => {
		const out = redactEmailAddresses(['a@example.com', 'b@example.com', 'a@example.com']);
		expect(out).toHaveLength(3);
		expect(out[0]).toBe(out[2]);
		expect(out[0]).not.toBe(out[1]);
	});
});

describe('redactSubject', () => {
	it('keeps only the length and a digest', () => {
		const redacted = redactSubject('Re: invoice 4012 overdue');
		expect(redacted).toBe(`[subject len=24 ${redactionDigest('Re: invoice 4012 overdue')}]`);
		expect(redacted).not.toContain('invoice');
	});

	it('is stable and distinguishes different subjects', () => {
		expect(redactSubject('hello')).toBe(redactSubject('hello'));
		expect(redactSubject('hello')).not.toBe(redactSubject('world'));
	});

	it('does not normalize case — a subject is prose, not an identifier', () => {
		expect(redactSubject('Hello')).not.toBe(redactSubject('hello'));
	});

	it('reports an empty subject as length zero', () => {
		expect(redactSubject('')).toMatch(/^\[subject len=0 [0-9a-f]{12}\]$/);
	});
});

describe('redactionDigest', () => {
	it('is 12 lowercase hex chars', () => {
		expect(redactionDigest('anything')).toMatch(/^[0-9a-f]{12}$/);
	});

	it('spreads single-character changes across the token', () => {
		expect(redactionDigest('aaaaaaaa')).not.toBe(redactionDigest('aaaaaaab'));
	});
});
