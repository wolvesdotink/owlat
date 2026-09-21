import { describe, it, expect } from 'vitest';
import {
	LOG_REDACT_PATHS,
	logRedactCensor,
	redactEmailAddress,
	redactSubject,
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

	it.each([
		'Alice <alice@example.com> (private name)',
		'alice@example.com (private name)',
		'alice@example.com\nprivate name',
	])('never preserves header prose after the domain: %s', (value) => {
		expect(redactEmailAddress(value)).toMatch(/^redacted-[0-9a-f]{12}$/);
	});

	it('passes the empty string through rather than hashing nothing', () => {
		expect(redactEmailAddress('')).toBe('');
		expect(redactEmailAddress('   ')).toBe('');
	});
});

describe('redactSubject', () => {
	it('keeps only the length and a digest', () => {
		const redacted = redactSubject('Re: invoice 4012 overdue');
		expect(redacted).toMatch(/^\[subject len=24 [0-9a-f]{12}\]$/);
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

describe('the digest behind both redactors', () => {
	it('spreads a single-character change across the token', () => {
		expect(redactSubject('aaaaaaaa')).not.toBe(redactSubject('aaaaaaab'));
		expect(redactEmailAddress('aaaaaaaa@example.com')).not.toBe(
			redactEmailAddress('aaaaaaab@example.com')
		);
	});
});

describe('LOG_REDACT_PATHS', () => {
	it('lists each key at the top level and one level down', () => {
		expect(LOG_REDACT_PATHS).toContain('rcptTo');
		expect(LOG_REDACT_PATHS).toContain('*.rcptTo');
		expect(LOG_REDACT_PATHS).toContain('subject');
		expect(LOG_REDACT_PATHS).toContain('*.subject');
	});

	it('has no duplicates, which pino rejects', () => {
		expect(new Set(LOG_REDACT_PATHS).size).toBe(LOG_REDACT_PATHS.length);
	});
});

describe('logRedactCensor', () => {
	it('redacts a string that looks like an address', () => {
		expect(logRedactCensor('marcel@example.com', ['rcptTo'])).toBe(
			redactEmailAddress('marcel@example.com')
		);
	});

	it('leaves a non-address value under an address-shaped key readable', () => {
		// The MTA writes `{ to: 'deferred' }` state labels through the same key.
		expect(logRedactCensor('deferred', ['to'])).toBe('deferred');
	});

	it('always redacts a subject, which has no shape to test for', () => {
		expect(logRedactCensor('hello', ['subject'])).toBe(redactSubject('hello'));
	});

	it('maps over a recipient list', () => {
		expect(logRedactCensor(['a@example.com', 'b@example.com'], ['to'])).toEqual([
			redactEmailAddress('a@example.com'),
			redactEmailAddress('b@example.com'),
		]);
	});

	it('censors an object outright — under these keys it is a parsed address', () => {
		expect(logRedactCensor({ address: 'a@example.com' }, ['from'])).toBe('[redacted]');
		expect(logRedactCensor(42, ['sender'])).toBe('[redacted]');
	});

	it('passes null and undefined through so absence stays legible', () => {
		expect(logRedactCensor(null, ['from'])).toBeNull();
		expect(logRedactCensor(undefined, ['from'])).toBeUndefined();
	});

	it('reads the last path segment, so a nested key is treated the same', () => {
		expect(logRedactCensor('marcel@example.com', ['job', 'to'])).toBe(
			redactEmailAddress('marcel@example.com')
		);
	});
});
