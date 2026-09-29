/**
 * The shared raw header splitter: where the header section ends, how fields
 * fold, and the unfolded lookup. Signer and verifier both run on these rules,
 * so each case pins one rule.
 */

import { describe, it, expect } from 'vitest';
import { findRawHeader, parseRawHeaderFields, splitRawHeaderBlock } from '../rawMessage.js';
import * as index from '../index.js';

describe('splitRawHeaderBlock', () => {
	it('splits a CRLF message at CRLFCRLF', () => {
		const msg = 'A: 1\r\nB: 2\r\n\r\nbody\r\n';
		const { headerBlock, bodyOffset } = splitRawHeaderBlock(msg);
		expect(headerBlock).toBe('A: 1\r\nB: 2');
		expect(msg.slice(bodyOffset)).toBe('body\r\n');
	});

	it('splits an LF-only message at LFLF', () => {
		const msg = 'A: 1\nB: 2\n\nbody\n';
		const { headerBlock, bodyOffset } = splitRawHeaderBlock(msg);
		expect(headerBlock).toBe('A: 1\nB: 2');
		expect(msg.slice(bodyOffset)).toBe('body\n');
	});

	it('takes an earlier LFLF over a later CRLFCRLF', () => {
		// LF-only headers with a CRLF blank line inside the body.
		const msg = 'A: 1\nB: 2\n\nline\r\n\r\nmore';
		const { headerBlock, bodyOffset } = splitRawHeaderBlock(msg);
		expect(headerBlock).toBe('A: 1\nB: 2');
		expect(msg.slice(bodyOffset)).toBe('line\r\n\r\nmore');
	});

	it('takes an earlier CRLFCRLF over a later LFLF', () => {
		const msg = 'A: 1\r\n\r\nbody\n\nmore';
		const { headerBlock, bodyOffset } = splitRawHeaderBlock(msg);
		expect(headerBlock).toBe('A: 1');
		expect(msg.slice(bodyOffset)).toBe('body\n\nmore');
	});

	it('ends the section at CRLF followed by a bare LF', () => {
		const msg = 'A: 1\r\n\nbody';
		const { headerBlock, bodyOffset } = splitRawHeaderBlock(msg);
		expect(headerBlock).toBe('A: 1\r');
		expect(msg.slice(bodyOffset)).toBe('body');
		expect(parseRawHeaderFields(headerBlock)).toEqual([{ name: 'a', casedName: 'A', raw: 'A: 1' }]);
	});

	it('treats a message with no blank line as all headers and no body', () => {
		const msg = 'A: 1\r\nB: 2';
		expect(splitRawHeaderBlock(msg)).toEqual({ headerBlock: msg, bodyOffset: msg.length });
	});

	it('keeps offsets byte-exact on 8-bit binary strings', () => {
		const msg = `X: ${String.fromCharCode(0xe9, 0xff)}\r\n\r\n${String.fromCharCode(0x80, 0xfe)}`;
		const { bodyOffset } = splitRawHeaderBlock(msg);
		expect(msg.slice(bodyOffset)).toBe(String.fromCharCode(0x80, 0xfe));
	});
});

describe('parseRawHeaderFields', () => {
	it('keeps name, cased name and verbatim bytes in order', () => {
		expect(parseRawHeaderFields('Subject:  Hi  there\r\nX-Tag:v')).toEqual([
			{ name: 'subject', casedName: 'Subject', raw: 'Subject:  Hi  there' },
			{ name: 'x-tag', casedName: 'X-Tag', raw: 'X-Tag:v' },
		]);
	});

	it('rejoins SP and HTAB continuations with CRLF', () => {
		const fields = parseRawHeaderFields('To: a@x,\r\n b@x,\r\n\tc@x\r\nFrom: f@x');
		expect(fields.map((f) => f.raw)).toEqual(['To: a@x,\r\n b@x,\r\n\tc@x', 'From: f@x']);
	});

	it('rejoins LF-only continuations with CRLF', () => {
		const fields = parseRawHeaderFields('To: a@x,\n b@x\nFrom: f@x');
		expect(fields.map((f) => f.raw)).toEqual(['To: a@x,\r\n b@x', 'From: f@x']);
	});

	it('handles mixed line endings', () => {
		const fields = parseRawHeaderFields('A: 1\r\n\t2\nB: 3\r\n 4');
		expect(fields.map((f) => f.raw)).toEqual(['A: 1\r\n\t2', 'B: 3\r\n 4']);
	});

	it.each([
		['\\v', '\v'],
		['\\f', '\f'],
		['NBSP', String.fromCharCode(0xa0)],
	])('a line starting with %s is its own field, not a continuation', (_label, lead) => {
		const fields = parseRawHeaderFields(`Subject: real\r\n${lead}X-Evil: 1`);
		expect(fields).toHaveLength(2);
		expect(fields[0]!.raw).toBe('Subject: real');
		expect(fields[1]!.raw).toBe(`${lead}X-Evil: 1`);
	});

	it('keeps a leading continuation line as its own field', () => {
		expect(parseRawHeaderFields(' stray\r\nA: 1').map((f) => f.raw)).toEqual([' stray', 'A: 1']);
	});

	it('names a colon-less line by the whole line', () => {
		expect(parseRawHeaderFields('Garbage Line\r\nA: 1')[0]).toEqual({
			name: 'garbage line',
			casedName: 'Garbage Line',
			raw: 'Garbage Line',
		});
	});

	it('drops the empty line a trailing terminator leaves behind', () => {
		expect(parseRawHeaderFields('A: 1\r\n').map((f) => f.raw)).toEqual(['A: 1']);
		expect(parseRawHeaderFields('A: 1\n')).toHaveLength(1);
		expect(parseRawHeaderFields('')).toEqual([]);
	});

	it('trims whitespace around the name', () => {
		expect(parseRawHeaderFields('Subject : x')[0]).toMatchObject({
			name: 'subject',
			casedName: 'Subject',
		});
	});
});

describe('findRawHeader', () => {
	const fields = parseRawHeaderFields(
		[
			'Content-Type: multipart/signed;',
			'\tprotocol="application/pgp-signature";',
			'  boundary="b1"  ',
			'Subject:  First ',
			'subject: Second',
			'NoColon',
		].join('\r\n')
	);

	it('unfolds continuations, joining each trimmed line with one space', () => {
		expect(findRawHeader(fields, 'content-type')).toBe(
			'multipart/signed; protocol="application/pgp-signature"; boundary="b1"'
		);
	});

	it('returns the first instance, matching case-insensitively', () => {
		expect(findRawHeader(fields, 'subject')).toBe('First');
		expect(findRawHeader(fields, 'SUBJECT')).toBe('First');
	});

	it('returns undefined when absent or without a colon', () => {
		expect(findRawHeader(fields, 'x-missing')).toBeUndefined();
		expect(findRawHeader(fields, 'nocolon')).toBeUndefined();
	});

	it('returns an empty string for an empty value', () => {
		expect(findRawHeader(parseRawHeaderFields('X-Empty:'), 'x-empty')).toBe('');
	});
});

describe('package surface', () => {
	it('re-exports the splitter from the package index', () => {
		expect(index.splitRawHeaderBlock).toBe(splitRawHeaderBlock);
		expect(index.parseRawHeaderFields).toBe(parseRawHeaderFields);
		expect(index.findRawHeader).toBe(findRawHeader);
	});
});
