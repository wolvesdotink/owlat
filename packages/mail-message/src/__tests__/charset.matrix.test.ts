import { describe, it, expect } from 'vitest';
import { decodeCharset, normalizeCharset } from '../parse/charset';

const b = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

/**
 * The charset matrix pins the SANCTIONED "corrected per-part charset decoding"
 * improvement (D2b): labels resolve the WHATWG way (notably the iso-8859-1 /
 * us-ascii / latin1 family → windows-1252), each part decodes under its OWN
 * declared charset, and a leading BOM overrides the declared label. An unknown
 * charset degrades to a byte-preserving latin1 decode and never throws.
 */
describe('decodeCharset matrix', () => {
	it('ISO-8859-1 resolves to the windows-1252 decoder (0x80 → €)', () => {
		expect(decodeCharset(b(0x80), 'iso-8859-1')).toBe('€');
		expect(decodeCharset(b(0xe9), 'ISO-8859-1')).toBe('é');
	});

	it('windows-1252 decodes the C1 smart-quote range', () => {
		expect(decodeCharset(b(0x93, 0x94), 'windows-1252')).toBe('“”');
	});

	it('Shift_JIS decodes multibyte kana (and its legacy aliases)', () => {
		expect(decodeCharset(b(0x82, 0xa0), 'Shift_JIS')).toBe('あ');
		expect(decodeCharset(b(0x82, 0xa0), 'shift-jis')).toBe('あ');
		expect(decodeCharset(b(0x82, 0xa0), 'x-sjis')).toBe('あ');
	});

	it('GB2312 and gb18030 both decode Chinese via the GBK family', () => {
		expect(decodeCharset(b(0xd6, 0xd0), 'gb2312')).toBe('中');
		expect(decodeCharset(b(0xd6, 0xd0), 'GB18030')).toBe('中');
	});

	it('EUC-KR decodes Hangul (and the ks_c_5601-1987 alias)', () => {
		expect(decodeCharset(b(0xc7, 0xd1), 'euc-kr')).toBe('한');
		expect(decodeCharset(b(0xc7, 0xd1), 'ks_c_5601-1987')).toBe('한');
	});

	it('KOI8-R decodes Cyrillic', () => {
		expect(decodeCharset(b(0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4), 'koi8-r')).toBe('Привет');
	});

	it('a UTF-8 BOM overrides the declared charset and is stripped', () => {
		// Declared windows-1252, but a UTF-8 BOM wins → plain "hi".
		expect(decodeCharset(b(0xef, 0xbb, 0xbf, 0x68, 0x69), 'windows-1252')).toBe('hi');
		// A UTF-16LE BOM decodes little-endian units and is stripped.
		expect(decodeCharset(b(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00), 'iso-8859-1')).toBe('hi');
	});

	it('a lying declared charset is honored verbatim (no content sniffing)', () => {
		// UTF-8 bytes for "é" but the part claims iso-8859-1 → windows-1252 view.
		expect(decodeCharset(b(0xc3, 0xa9), 'iso-8859-1')).toBe('Ã©');
	});

	it('a missing charset defaults to us-ascii', () => {
		expect(decodeCharset(b(0x41, 0x42), undefined)).toBe('AB');
		expect(decodeCharset(b(0x41, 0x42), '')).toBe('AB');
	});

	it('an unknown charset falls back to a byte-preserving latin1 decode', () => {
		// latin1 is 1:1 with bytes: 0xE9 -> U+00E9, 0xFF -> U+00FF, nothing lost.
		expect(decodeCharset(b(0xff), 'x-not-a-real-charset')).toBe('ÿ');
		expect(decodeCharset(b(0xe9), 'x-not-a-real-charset')).toBe('é');
	});

	it('malformed bytes under a strict encoding degrade to U+FFFD, never throw', () => {
		expect(() => decodeCharset(b(0xff, 0xff, 0xff), 'utf-8')).not.toThrow();
		expect(decodeCharset(b(0xff), 'utf-8')).toBe('�');
	});
});

describe('normalizeCharset', () => {
	it('maps the latin1/us-ascii family onto windows-1252', () => {
		expect(normalizeCharset('iso-8859-1')).toBe('windows-1252');
		expect(normalizeCharset('LATIN1')).toBe('windows-1252');
		expect(normalizeCharset('us-ascii')).toBe('windows-1252');
		expect(normalizeCharset(undefined)).toBe('windows-1252');
	});
	it('canonicalizes legacy CJK labels', () => {
		expect(normalizeCharset('gb2312')).toBe('gbk');
		expect(normalizeCharset('Shift-JIS')).toBe('shift_jis');
		expect(normalizeCharset('ks_c_5601-1987')).toBe('euc-kr');
	});
	it('passes an already-canonical label through untouched', () => {
		expect(normalizeCharset('utf-8')).toBe('utf-8');
		expect(normalizeCharset('koi8-r')).toBe('koi8-r');
	});
});
