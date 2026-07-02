import { describe, expect, it } from 'vitest';
import { parseUnsubscribeMailto } from '../unsubscribeMailto';

describe('parseUnsubscribeMailto', () => {
	it('parses a bare address', () => {
		expect(parseUnsubscribeMailto('mailto:unsub@example.com')).toEqual({
			to: ['unsub@example.com'],
			subject: undefined,
			body: undefined,
		});
	});

	it('parses subject and body query params', () => {
		expect(
			parseUnsubscribeMailto('mailto:unsub@example.com?subject=unsubscribe&body=please%20remove%20me'),
		).toEqual({
			to: ['unsub@example.com'],
			subject: 'unsubscribe',
			body: 'please remove me',
		});
	});

	it('splits multiple comma-separated recipients (RFC 6068)', () => {
		expect(parseUnsubscribeMailto('mailto:a@x.com,b@y.com?subject=unsub')?.to).toEqual([
			'a@x.com',
			'b@y.com',
		]);
	});

	it('percent-decodes the address part', () => {
		expect(parseUnsubscribeMailto('mailto:list%2Bunsub@example.com')?.to).toEqual([
			'list+unsub@example.com',
		]);
	});

	it('does not throw on malformed percent-encoding (falls back to the raw text)', () => {
		expect(parseUnsubscribeMailto('mailto:a%zz@example.com')?.to).toEqual(['a%zz@example.com']);
		expect(parseUnsubscribeMailto('mailto:x@y.com?body=100%zz')?.body).toBe('100%zz');
	});

	it('keeps a literal + in query values (RFC 6068, not form encoding)', () => {
		expect(parseUnsubscribeMailto('mailto:u@x.com?subject=a+b')?.subject).toBe('a+b');
	});

	it('returns the hostile body verbatim for the caller to escape', () => {
		const parsed = parseUnsubscribeMailto(
			'mailto:unsub@evil.test?body=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
		);
		expect(parsed?.body).toBe('<img src=x onerror=alert(1)>');
	});

	it('rejects URIs without a recipient', () => {
		expect(parseUnsubscribeMailto('mailto:?subject=unsub')).toBeNull();
		expect(parseUnsubscribeMailto('mailto: , ')).toBeNull();
		expect(parseUnsubscribeMailto('https://example.com/unsub')).toBeNull();
		expect(parseUnsubscribeMailto('')).toBeNull();
	});
});
