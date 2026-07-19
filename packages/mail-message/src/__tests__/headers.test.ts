import { describe, it, expect } from 'vitest';
import {
	unfold,
	decodeEncodedWords,
	decodeHeaderValue,
	decodeRfc2231,
	splitHeaderLines,
	parseHeaders,
	parseStructuredHeader,
} from '../parse/headers';
import { parseContentType, getBoundary, isMultipart } from '../parse/contentType';

describe('unfold', () => {
	it('collapses CRLF folding whitespace into a single space', () => {
		expect(unfold('a\r\n b')).toBe('a b');
		expect(unfold('a\n\tb')).toBe('a b');
	});
	it('leaves an unfolded value untouched', () => {
		expect(unfold('plain value')).toBe('plain value');
	});
});

describe('decodeEncodedWords (relocated, byte-identical)', () => {
	it('honors a non-UTF-8 declared charset', () => {
		expect(decodeEncodedWords('=?iso-8859-1?Q?caf=E9?=')).toBe('café');
	});
	it('leaves an undecodable payload intact', () => {
		expect(decodeEncodedWords('=?utf-8?B?!!!nope!!!?=')).toBe('=?utf-8?B?!!!nope!!!?=');
	});
});

describe('decodeHeaderValue — folded mid-run of encoded words', () => {
	it('drops the whitespace between two adjacent encoded words across a fold', () => {
		// Q-encoded "Hello," then " world"; the fold must NOT inject a space.
		const raw = '=?utf-8?Q?Hello=2C?=\r\n =?utf-8?Q?_world?=';
		expect(decodeHeaderValue(raw)).toBe('Hello, world');
	});
	it('keeps ordinary spaces around non-encoded text', () => {
		expect(decodeHeaderValue('Re: =?utf-8?B?w6k=?= end')).toBe('Re: é end');
	});
	it('parseHeaders().getDecoded applies the same decoding', () => {
		const h = parseHeaders('Subject: =?utf-8?Q?Hello=2C?=\r\n =?utf-8?Q?_world?=');
		expect(h.getDecoded('subject')).toBe('Hello, world');
		expect(h.getDecoded('missing')).toBeUndefined();
	});
});

describe('decodeRfc2231', () => {
	it('strips the charset/lang prefix and percent-decodes', () => {
		expect(decodeRfc2231("utf-8'en'a%20b")).toBe('a b');
	});
	it('returns the raw value when there is no prefix', () => {
		expect(decodeRfc2231('plain')).toBe('plain');
	});
	it('falls back to the raw value on a malformed percent-escape', () => {
		expect(decodeRfc2231("utf-8''%zz")).toBe('%zz');
	});
});

describe('splitHeaderLines', () => {
	it('lowercases names and preserves repeated headers in order', () => {
		const map = splitHeaderLines('Received: a\r\nReceived: b\r\nSubject: hi');
		expect(map.get('received')).toEqual(['a', 'b']);
		expect(map.get('subject')).toEqual(['hi']);
	});
	it('unfolds a folded value and ignores lines with no colon', () => {
		const map = splitHeaderLines('X-Long: one\r\n two\r\ngarbage-no-colon');
		expect(map.get('x-long')).toEqual(['one two']);
		expect(map.has('garbage-no-colon')).toBe(false);
	});
});

describe('MessageHeaders', () => {
	const h = parseHeaders(
		[
			'Received: from a',
			'Received: from b',
			'Content-Type: text/html; charset="utf-8"',
			'Content-Disposition: inline',
		].join('\r\n')
	);
	it('exposes get / getAll / has / names', () => {
		expect(h.get('received')).toBe('from a');
		expect(h.getAll('received')).toEqual(['from a', 'from b']);
		expect(h.has('content-type')).toBe(true);
		expect(h.has('nope')).toBe(false);
		expect(h.names()).toContain('content-type');
	});
	it('returns undefined for an absent header', () => {
		expect(h.get('x-none')).toBeUndefined();
	});
	it('parses structured content-type and disposition', () => {
		expect(h.contentType.value).toBe('text/html');
		expect(h.contentType.params['charset']).toBe('utf-8');
		expect(h.contentDisposition?.value).toBe('inline');
	});
	it('defaults content-type to text/plain and disposition to undefined when absent', () => {
		const bare = parseHeaders('Subject: hi');
		expect(bare.contentType.value).toBe('text/plain');
		expect(bare.contentType.params).toEqual({});
		expect(bare.contentDisposition).toBeUndefined();
	});
});

describe('parseStructuredHeader — RFC 2231 continuations with charset', () => {
	it('reassembles and percent-decodes an extended continued parameter', () => {
		const raw =
			"application/x-stuff;\r\n title*0*=us-ascii'en'This%20is%20;\r\n title*1*=%2A%2A%2Afun%2A%2A%2A";
		const s = parseStructuredHeader(raw);
		expect(s.value).toBe('application/x-stuff');
		expect(s.params['title']).toBe('This is ***fun***');
	});
	it('reassembles a plain (non-extended) continued parameter', () => {
		const raw = 'text/plain; name*0="a b "; name*1="c"';
		const s = parseStructuredHeader(raw);
		expect(s.params['name']).toBe('a b c');
	});
	it('decodes an RFC 2047 encoded word inside a simple param', () => {
		const s = parseStructuredHeader('attachment; filename==?utf-8?B?w6k=?=');
		expect(s.params['filename']).toBe('é');
	});
	it('returns an empty param map when there are no params', () => {
		expect(parseStructuredHeader('inline').params).toEqual({});
		expect(parseStructuredHeader(undefined).value).toBe('');
	});
});

describe('parseContentType — param survival', () => {
	it('preserves report-type=feedback-report alongside the boundary', () => {
		const ct = parseContentType('multipart/report; report-type=feedback-report; boundary="=_XYZ"');
		expect(ct.value).toBe('multipart/report');
		expect(ct.type).toBe('multipart');
		expect(ct.subtype).toBe('report');
		expect(ct.params['report-type']).toBe('feedback-report');
		expect(ct.params['boundary']).toBe('=_XYZ');
	});
	it('splits a type with no subtype and defaults blank input', () => {
		expect(parseContentType('application').subtype).toBe('');
		expect(parseContentType(undefined).value).toBe('text/plain');
	});
	it('getBoundary and isMultipart read the parsed params', () => {
		expect(getBoundary('multipart/mixed; boundary=ABC')).toBe('ABC');
		expect(getBoundary('text/plain')).toBeUndefined();
		expect(isMultipart('multipart/alternative; boundary=x')).toBe(true);
		expect(isMultipart('text/plain')).toBe(false);
	});
});
