import { describe, it, expect } from 'vitest';
import { parseMailto } from '../mailto';

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
