/**
 * Per-part charset decoding for MIME leaves.
 *
 * A single decode entry point built on the platform `TextDecoder` plus a
 * WHATWG-derived alias table that normalizes the messy legacy labels found in
 * real mail (`gb2312`, `shift-jis`, `ks_c_5601-1987`, …) onto the canonical
 * encoding names `TextDecoder` accepts. Anything `TextDecoder` cannot build
 * falls back to a byte-preserving latin1 decode so a bogus/unknown charset
 * never loses data and never throws.
 *
 * This is the sanctioned "corrected per-part charset decoding" improvement
 * (D2b): labels are resolved the WHATWG way — notably the `iso-8859-1` /
 * `us-ascii` family resolves to the `windows-1252` decoder, matching browsers
 * and the overwhelming reality of mislabelled mail — and each part is decoded
 * under ITS OWN declared charset rather than a single message-wide guess. The
 * corrected cases are pinned in `charset.matrix.test.ts`.
 */

import { bytesToBinaryString } from './binaryString';

/**
 * Legacy/label → canonical `TextDecoder` encoding. Only labels that need
 * normalization are listed; a label already understood by `TextDecoder` is
 * passed through untouched. The `iso-8859-1` / `us-ascii` / `latin1` family
 * maps to `windows-1252` per the WHATWG Encoding Standard.
 */
const CHARSET_ALIASES: Record<string, string> = {
	utf8: 'utf-8',
	'utf-8': 'utf-8',
	'unicode-1-1-utf-8': 'utf-8',
	'us-ascii': 'windows-1252',
	ascii: 'windows-1252',
	'ansi_x3.4-1968': 'windows-1252',
	'iso-8859-1': 'windows-1252',
	'iso8859-1': 'windows-1252',
	'iso_8859-1': 'windows-1252',
	'iso_8859-1:1987': 'windows-1252',
	latin1: 'windows-1252',
	l1: 'windows-1252',
	cp819: 'windows-1252',
	cp1252: 'windows-1252',
	'windows-1252': 'windows-1252',
	'x-cp1252': 'windows-1252',
	'iso-8859-15': 'iso-8859-15',
	'iso8859-15': 'iso-8859-15',
	latin9: 'iso-8859-15',
	'koi8-r': 'koi8-r',
	cskoi8r: 'koi8-r',
	'koi8-u': 'koi8-u',
	'koi8-ru': 'koi8-u',
	shift_jis: 'shift_jis',
	'shift-jis': 'shift_jis',
	sjis: 'shift_jis',
	'x-sjis': 'shift_jis',
	ms_kanji: 'shift_jis',
	'windows-31j': 'shift_jis',
	cp932: 'shift_jis',
	'euc-jp': 'euc-jp',
	'x-euc-jp': 'euc-jp',
	gb2312: 'gbk',
	'gb_2312-80': 'gbk',
	csgb2312: 'gbk',
	chinese: 'gbk',
	gbk: 'gbk',
	'x-gbk': 'gbk',
	gb18030: 'gb18030',
	'euc-kr': 'euc-kr',
	'ks_c_5601-1987': 'euc-kr',
	ksc5601: 'euc-kr',
	ksc_5601: 'euc-kr',
	korean: 'euc-kr',
	cseuckr: 'euc-kr',
	big5: 'big5',
	'big5-hkscs': 'big5',
	'cn-big5': 'big5',
	'windows-1250': 'windows-1250',
	'windows-1251': 'windows-1251',
	'windows-1253': 'windows-1253',
	'windows-1254': 'windows-1254',
	'windows-1255': 'windows-1255',
	'windows-1256': 'windows-1256',
	'windows-1257': 'windows-1257',
	'windows-1258': 'windows-1258',
};

/** Canonicalize a declared charset label; absent/blank defaults to us-ascii. */
export function normalizeCharset(label: string | undefined): string {
	const raw = (label ?? 'us-ascii').trim().toLowerCase();
	// A blank label defaults to us-ascii, then resolves through the one alias
	// table (us-ascii → windows-1252) — no hardcoded duplicate of that mapping.
	const effective = raw === '' ? 'us-ascii' : raw;
	return CHARSET_ALIASES[effective] ?? effective;
}

/**
 * Decode `bytes` under `label` via a non-fatal `TextDecoder` (malformed
 * sequences become U+FFFD, never a throw). If `TextDecoder` cannot be built for
 * the label, fall back to a byte-preserving latin1 decode.
 */
function decodeWithLabel(label: string, bytes: Uint8Array): string {
	try {
		return new TextDecoder(label, { fatal: false, ignoreBOM: false }).decode(bytes);
	} catch {
		return bytesToBinaryString(bytes);
	}
}

/** A byte-order mark override: encoding to use and how many bytes to drop. */
function sniffBom(bytes: Uint8Array): { label: string; skip: number } | undefined {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		return { label: 'utf-8', skip: 3 };
	}
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
		return { label: 'utf-16le', skip: 2 };
	}
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		return { label: 'utf-16be', skip: 2 };
	}
	return undefined;
}

/**
 * Decode a MIME leaf's raw bytes into a string.
 *
 * A leading Unicode BOM overrides the declared charset (and is stripped);
 * otherwise the declared `charset` is normalized through the WHATWG alias table
 * and decoded. Never throws: an unknown charset degrades to a byte-preserving
 * latin1 decode, malformed bytes to U+FFFD.
 */
export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
	const bom = sniffBom(bytes);
	if (bom) return decodeWithLabel(bom.label, bytes.subarray(bom.skip));
	return decodeWithLabel(normalizeCharset(charset), bytes);
}

/**
 * The UTF-16 labels {@link decodeDeclaredCharset} handles itself, and the byte
 * order each fixes. `utf-16` (and its IANA alias) fixes none: a BOM gives it, and
 * without one it is big-endian, as RFC 2781 §4.3 says. A label that only begins
 * with `utf-16` is not one of these and takes the usual fallback.
 */
const DECLARED_UTF16: Record<string, 'utf-16le' | 'utf-16be' | 'bom-or-be'> = {
	'utf-16': 'bom-or-be',
	csutf16: 'bom-or-be',
	'utf-16le': 'utf-16le',
	csutf16le: 'utf-16le',
	'utf-16be': 'utf-16be',
	csutf16be: 'utf-16be',
};

/**
 * Decode a MIME leaf's raw bytes under the charset it DECLARES, where a
 * byte-order mark never switches the encoding (as it does in
 * {@link decodeCharset}). Only the declared decoder reads its own BOM:
 *   - UTF-8: a UTF-8 BOM is stripped.
 *   - `utf-16`: a UTF-16 BOM gives the byte order and is stripped; with none the
 *     bytes are big-endian (RFC 2781 §4.3).
 *   - `utf-16le` / `utf-16be`: the byte order is the label's. A BOM in that
 *     order is stripped; one in the other order is data (U+FFFE), never a
 *     reason to swap (RFC 2781 §4.1-4.2: these labels carry no BOM).
 *   - any other charset: the BOM's bytes are text in that charset.
 * Same alias table and fallback as {@link decodeCharset}.
 */
export function decodeDeclaredCharset(bytes: Uint8Array, charset: string | undefined): string {
	const label = normalizeCharset(charset);
	const utf16 = DECLARED_UTF16[label];
	if (utf16 === 'bom-or-be') {
		const bom = sniffBom(bytes);
		if (bom && bom.label !== 'utf-8') return decodeWithLabel(bom.label, bytes.subarray(bom.skip));
		return decodeWithLabel('utf-16be', bytes);
	}
	// The WHATWG decoder strips a BOM of its own encoding and of no other.
	return decodeWithLabel(utf16 ?? label, bytes);
}
