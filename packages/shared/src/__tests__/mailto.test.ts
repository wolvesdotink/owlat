import { describe, it, expect } from 'vitest';
import { parseMailto, splitMailtoAddressList } from '../mailto';

describe('parseMailto', () => {
	it('parses a single recipient in the path', () => {
		expect(parseMailto('mailto:user@example.com')).toEqual({
			to: ['user@example.com'],
			cc: [],
			bcc: [],
		});
	});

	it('splits multiple comma-separated recipients in the path', () => {
		expect(parseMailto('mailto:a@x.com,b@y.com')?.to).toEqual(['a@x.com', 'b@y.com']);
	});

	it('merges path recipients with `to` query fields', () => {
		expect(parseMailto('mailto:a@x.com?to=b@y.com,c@z.com')?.to).toEqual([
			'a@x.com',
			'b@y.com',
			'c@z.com',
		]);
	});

	it('supports recipients supplied only via the query', () => {
		expect(parseMailto('mailto:?to=a@x.com')?.to).toEqual(['a@x.com']);
	});

	it('collects cc and bcc', () => {
		const parsed = parseMailto('mailto:a@x.com?cc=c1@x.com,c2@x.com&bcc=b@y.com');
		expect(parsed?.cc).toEqual(['c1@x.com', 'c2@x.com']);
		expect(parsed?.bcc).toEqual(['b@y.com']);
	});

	it('percent-decodes the subject and body', () => {
		const parsed = parseMailto('mailto:a@x.com?subject=Hello%20there&body=Line%20one%0ALine%20two');
		expect(parsed?.subject).toBe('Hello there');
		expect(parsed?.body).toBe('Line one\nLine two');
	});

	it('decodes percent-encoded characters in an address', () => {
		expect(parseMailto('mailto:list%2Bnews@example.com')?.to).toEqual(['list+news@example.com']);
	});

	it('keeps a literal + in an address (mailto is not form-encoded)', () => {
		expect(parseMailto('mailto:list+news@example.com')?.to).toEqual(['list+news@example.com']);
	});

	it('keeps the first occurrence when subject repeats', () => {
		expect(parseMailto('mailto:a@x.com?subject=First&subject=Second')?.subject).toBe('First');
	});

	it('trims whitespace around addresses and drops empties', () => {
		expect(parseMailto('mailto:a@x.com , , b@y.com')?.to).toEqual(['a@x.com', 'b@y.com']);
	});

	it('degrades a malformed percent-escape to the raw text rather than throwing', () => {
		expect(parseMailto('mailto:a%zz@example.com')?.to).toEqual(['a%zz@example.com']);
		expect(parseMailto('mailto:x@y.com?body=100%zz')?.body).toBe('100%zz');
	});

	it('returns null for a non-mailto URL', () => {
		expect(parseMailto('https://example.com')).toBeNull();
		expect(parseMailto('owlat://thread/1')).toBeNull();
	});

	it('returns null when there is nothing usable to compose', () => {
		expect(parseMailto('mailto:')).toBeNull();
		expect(parseMailto('mailto: , ')).toBeNull();
	});

	it('returns a composable object when only a subject is present', () => {
		expect(parseMailto('mailto:?subject=Hi')).toEqual({ to: [], cc: [], bcc: [], subject: 'Hi' });
	});

	it('is not fooled by a non-string input', () => {
		// @ts-expect-error — exercising the runtime guard
		expect(parseMailto(null)).toBeNull();
	});
});

// The `mailto:` target of a List-Unsubscribe header on received mail.
describe('parseMailto on List-Unsubscribe targets', () => {
	it('parses subject and body alongside the recipient', () => {
		expect(
			parseMailto('mailto:unsub@example.com?subject=unsubscribe&body=please%20remove%20me')
		).toEqual({
			to: ['unsub@example.com'],
			cc: [],
			bcc: [],
			subject: 'unsubscribe',
			body: 'please remove me',
		});
	});

	it('reads a recipient given only as a `to` field (empty path)', () => {
		expect(parseMailto('mailto:?to=unsub@list.example&subject=unsubscribe')).toEqual({
			to: ['unsub@list.example'],
			cc: [],
			bcc: [],
			subject: 'unsubscribe',
		});
	});

	it('splits comma-separated recipients next to a subject', () => {
		expect(parseMailto('mailto:a@x.com,b@y.com?subject=unsub')?.to).toEqual(['a@x.com', 'b@y.com']);
	});

	it('decodes %2B in the address', () => {
		expect(parseMailto('mailto:list%2Bunsub@example.com')?.to).toEqual(['list+unsub@example.com']);
	});

	it('keeps a literal + in a query value (not form encoding)', () => {
		expect(parseMailto('mailto:u@x.com?subject=a+b')?.subject).toBe('a+b');
	});

	it('returns a hostile body verbatim for the caller to escape', () => {
		const parsed = parseMailto(
			'mailto:unsub@evil.test?body=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E'
		);
		expect(parsed?.body).toBe('<img src=x onerror=alert(1)>');
	});

	it('returns null for a non-mailto target or an empty string', () => {
		expect(parseMailto('https://example.com/unsub')).toBeNull();
		expect(parseMailto('')).toBeNull();
	});
});

describe('splitMailtoAddressList', () => {
	it('splits, trims and drops empties', () => {
		expect(splitMailtoAddressList(' a@x.com , ,b@y.com ')).toEqual(['a@x.com', 'b@y.com']);
		expect(splitMailtoAddressList('')).toEqual([]);
	});

	it('leaves an already-decoded list alone by default', () => {
		expect(splitMailtoAddressList('a%41b@x.com, list+news@y.com')).toEqual([
			'a%41b@x.com',
			'list+news@y.com',
		]);
	});

	it('decodes each entry after the split when asked', () => {
		expect(splitMailtoAddressList('a%2Cb@x.com,c%40y.com', { decode: true })).toEqual([
			'a,b@x.com',
			'c@y.com',
		]);
	});

	it('round-trips the deep-link hand-off: parseMailto output joined with ", "', () => {
		const parsed = parseMailto('mailto:list%2Bnews@example.com,b@y.com?to=c@z.com');
		expect(splitMailtoAddressList(parsed?.to.join(', ') ?? '')).toEqual(parsed?.to);
	});
});
