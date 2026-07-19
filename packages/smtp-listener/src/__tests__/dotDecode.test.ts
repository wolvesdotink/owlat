import { describe, it, expect } from 'vitest';
import { dotDecode } from '../dotDecode.js';

const dec = (s: string): string => dotDecode(Buffer.from(s, 'binary')).toString('binary');

describe('dotDecode', () => {
	it('leaves a message without stuffed lines untouched', () => {
		expect(dec('Subject: hi\r\n\r\nbody line\r\n')).toBe('Subject: hi\r\n\r\nbody line\r\n');
	});

	it('removes one leading dot from a stuffed line', () => {
		// Wire "..leading" decodes to ".leading" (RFC 5321 §4.5.2).
		expect(dec('..leading dot\r\n')).toBe('.leading dot\r\n');
	});

	it('removes exactly one dot, preserving the rest', () => {
		expect(dec('...three\r\n')).toBe('..three\r\n');
	});

	it('un-stuffs a leading dot on the first line', () => {
		expect(dec('.first\r\nsecond\r\n')).toBe('first\r\nsecond\r\n');
	});

	it('un-stuffs a leading dot on an interior line only', () => {
		expect(dec('a\r\n..b\r\nc\r\n')).toBe('a\r\n..b\r\nc\r\n'.replace('..b', '.b'));
	});

	it('does not touch dots that are not at the start of a line', () => {
		expect(dec('a.b.c\r\nx . y\r\n')).toBe('a.b.c\r\nx . y\r\n');
	});

	it('handles multiple stuffed lines', () => {
		expect(dec('.one\r\n..two\r\nthree\r\n.four\r\n')).toBe('one\r\n.two\r\nthree\r\nfour\r\n');
	});

	it('handles an empty buffer', () => {
		expect(dotDecode(Buffer.alloc(0)).length).toBe(0);
	});

	it('is byte-preserving for binary content (no charset assumptions)', () => {
		const raw = Buffer.from([0x2e, 0x2e, 0xff, 0x00, 0x0d, 0x0a, 0x2e, 0x80]);
		// Leading ".." -> ".", then binary bytes, then a stuffed "." at line start.
		expect([...dotDecode(raw)]).toEqual([0x2e, 0xff, 0x00, 0x0d, 0x0a, 0x80]);
	});

	it('treats a lone LF (bare newline) as a line boundary', () => {
		expect(dec('a\n.b\n')).toBe('a\nb\n');
	});
});
