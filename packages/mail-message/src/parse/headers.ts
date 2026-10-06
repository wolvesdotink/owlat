/**
 * RFC 5322 / RFC 2047 / RFC 2231 header primitives.
 *
 * This is the canonical home of the header helpers for every MIME reader in the
 * repository. `packages/shared/src/mailMime.ts` is an adapter over this package
 * and re-exports `decodeEncodedWords` for its existing importers.
 */

import { parseContentType, type ContentType } from './contentType';
import { binaryStringToBytes } from './binaryString';
import { decodeCharset } from './charset';

/**
 * Collapse RFC 5322 folding whitespace: a CRLF (or bare LF) followed by at
 * least one space/tab is folding introduced for line-length limits and
 * represents a single space in the logical header value.
 */
export function unfold(headerText: string): string {
	return headerText.replace(/\r?\n[ \t]+/g, ' ');
}

/**
 * Decode `=HH` hex escapes (quoted-printable / RFC 2047 Q-encoding) into their
 * raw bytes-as-chars. Callers apply their own pre-step first: Q-encoding maps
 * `_`→space, the QP body strips soft line breaks (`=\r?\n`).
 */
export function decodeQpHexEscapes(s: string): string {
	return s.replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) =>
		String.fromCharCode(Number.parseInt(h, 16))
	);
}

/**
 * A charset label as the `TextDecoder` in scope types it. The label is whatever
 * the sender wrote and the constructor is what validates it (an unknown one
 * throws, and the caller falls back to utf-8), but Bun's global typings narrow
 * the parameter to the labels Bun supports. Deriving the type keeps the cast
 * honest under Node's `string` and Bun's union alike.
 */
type DecoderLabel = ConstructorParameters<typeof TextDecoder>[0];

/**
 * Decode RFC 2047 encoded-words (`=?charset?B|Q?payload?=`), honoring the
 * DECLARED charset. Falls back utf-8 → raw payload when the charset is
 * unknown. `@owlat/shared/mailMime` re-exports this exact function.
 */
export function decodeEncodedWords(s: string): string {
	return s.replace(
		/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
		(whole, charset: string, enc: string, text: string) => {
			try {
				let bin: string;
				if (enc.toUpperCase() === 'B') {
					bin = atob(text);
				} else {
					bin = decodeQpHexEscapes(text.replace(/_/g, ' '));
				}
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
				const cs = charset.toLowerCase() === 'utf8' ? 'utf-8' : charset;
				try {
					return new TextDecoder(cs as DecoderLabel).decode(bytes);
				} catch {
					return new TextDecoder('utf-8').decode(bytes);
				}
			} catch {
				return whole;
			}
		}
	);
}

/**
 * Decode a full header value: unfold, drop the whitespace RFC 2047 §6.2
 * mandates be ignored between two ADJACENT encoded words (so a fold landing
 * mid-run of encoded words does not inject a spurious space), then decode the
 * encoded words. Plain header text is returned unfolded.
 */
export function decodeHeaderValue(raw: string): string {
	const unfolded = unfold(raw).trim();
	// Whitespace between two adjacent encoded words is not part of the text.
	const joined = unfolded.replace(
		/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?[^?]+\?[bBqQ]\?[^?]*\?=)/g,
		'$1'
	);
	return decodeEncodedWords(joined);
}

/** Any char above U+007F: a byte of an 8-bit header value, or decoded text. */
const NON_ASCII = /[\u0080-\uffff]/;

/** A char above U+00FF, which no byte of a binary string can be. */
const NOT_A_BYTE = /[\u0100-\uffff]/;

/**
 * A raw header value, held as a binary string (one char per byte), as text.
 *
 * RFC 6532 lets a header carry UTF-8 unencoded, and many mailers send it that
 * way, so 8-bit bytes are read as UTF-8 when they are valid UTF-8. Bytes that
 * are not are a legacy unencoded 8-bit header, read as windows-1252, as every
 * other mail reader does. ASCII, and a string that already holds a char no byte
 * can be (decoded text), come back unchanged. RFC 2047 encoded words are ASCII
 * and are left for {@link decodeHeaderValue}, which must run on the result: the
 * bytes are decoded first, so that unfolding, trimming and the encoded words
 * all see characters rather than bytes.
 *
 * Never trim or `\s`-match the binary string before this: `String#trim`
 * treats the byte 0xA0, the last byte of `à` or `Р`, as whitespace.
 */
export function headerBytesToText(value: string): string {
	if (!NON_ASCII.test(value) || NOT_A_BYTE.test(value)) return value;
	const bytes = binaryStringToBytes(value);
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return decodeCharset(bytes, 'windows-1252');
	}
}

/**
 * A raw header value (binary string) as one line of display text: its bytes
 * read as text ({@link headerBytesToText}), unfolded, its encoded words decoded
 * ({@link decodeHeaderValue}) and its control characters collapsed
 * ({@link collapseControlChars}). This is how Subject and the other
 * unstructured display headers are read.
 */
export function decodeRawHeaderValue(raw: string): string {
	return collapseControlChars(decodeHeaderValue(headerBytesToText(raw)));
}

/**
 * A run of C0 controls other than TAB, or DEL, with the blanks around it. The
 * run must start with one of those controls; TAB only joins a run.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_RUN = /[ \t]*[\u0000-\u0008\u000a-\u001f\u007f][\u0000-\u001f\u007f \t]*/g;

/**
 * Decoded header text as one line: each run of control characters (C0 except
 * TAB, and DEL, with the blanks around it) becomes a single space, and the ends
 * are trimmed. An RFC 2047 encoded word can carry any byte, CR and LF included,
 * so text decoded from one is not yet safe to place where a header line is
 * rebuilt or framed.
 */
export function collapseControlChars(text: string): string {
	return text.replace(CONTROL_RUN, ' ').trim();
}

/**
 * Decode an RFC 2231 extended parameter value (`charset'lang'pct-encoded`),
 * falling back to the raw value when there is no language/charset prefix or
 * the percent-decode fails.
 */
export function decodeRfc2231(v: string): string {
	const m = v.match(/^[^']*'[^']*'(.*)$/);
	const enc = m ? m[1]! : v;
	try {
		return decodeURIComponent(enc);
	} catch {
		return enc;
	}
}

/**
 * Highest RFC 2231 continuation index (`name*N`) a parameter is assembled
 * from. The RFC sets no bound, but a real value runs to a few dozen segments;
 * the index is attacker-chosen, so a segment past this is ignored, as one
 * past the largest array index always was.
 */
export const MAX_CONTINUATION_INDEX = 999;

/**
 * Extract a structured-header param by name from a RAW header value.
 *
 * The `(?:^|[;\s])` anchor matches a param introduced after ANY whitespace, not
 * only after a `;`, so real broken generators that emit
 * `Content-Disposition: attachment filename="x"` or
 * `Content-Type: multipart/mixed boundary="B"` (no semicolon) still yield their
 * params. RFC 2231 continuations (`name*0`, `name*1*`) are reassembled and
 * percent-decoded.
 *
 * This is the single home of the whitespace-anchored param scanner: the MIME
 * walker uses it for boundary and filename extraction, and every reader built
 * on that walker (including `@owlat/shared/mailMime`) inherits it.
 */
export function getRawParam(headerValue: string | undefined, name: string): string | undefined {
	if (!headerValue) return undefined;
	// Only the segments present, by index (a later duplicate wins), joined in
	// index order: never an array sized by an attacker-chosen index.
	const continued = new Map<number, string>();
	const contRe = new RegExp(
		`(?:^|[;\\s])${name}\\*(\\d+)\\*?\\s*=\\s*("([^"]*)"|([^;\\r\\n]+))`,
		'gi'
	);
	let cm: RegExpExecArray | null;
	while ((cm = contRe.exec(headerValue))) {
		const index = Number.parseInt(cm[1]!, 10);
		if (index > MAX_CONTINUATION_INDEX) continue;
		continued.set(index, (cm[3] ?? cm[4] ?? '').trim());
	}
	if (continued.size > 0) {
		const joined = [...continued.keys()]
			.sort((a, b) => a - b)
			.map((index) => continued.get(index))
			.join('');
		return decodeRfc2231(joined);
	}
	const re = new RegExp(`(?:^|[;\\s])${name}\\*?\\s*=\\s*("([^"]*)"|([^;\\r\\n]+))`, 'i');
	const m = headerValue.match(re);
	const value = m ? (m[2] ?? m[3] ?? '') : undefined;
	return value ? decodeRfc2231(value.trim()) : undefined;
}

/** Whether `code` is ASCII whitespace: TAB, LF, VT, FF, CR or space. */
function isAsciiWhitespace(code: number): boolean {
	return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

/**
 * `s` without leading and trailing ASCII whitespace. A header value is still a
 * binary string here, and `String#trim` would also drop a trailing byte 0xA0,
 * cutting the UTF-8 sequence of a final `à` or `Р` in half.
 */
function trimAsciiWhitespace(s: string): string {
	let start = 0;
	let end = s.length;
	while (start < end && isAsciiWhitespace(s.charCodeAt(start))) start++;
	while (end > start && isAsciiWhitespace(s.charCodeAt(end - 1))) end--;
	return s.slice(start, end);
}

/**
 * Split a raw header block (everything before the blank line that separates
 * headers from body) into a case-insensitive multimap of UNFOLDED raw values,
 * preserving the order and multiplicity of repeated headers (`Received:`).
 */
export function splitHeaderLines(headerBlock: string): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const line of unfold(headerBlock).split(/\r?\n/)) {
		const idx = line.indexOf(':');
		if (idx < 0) continue;
		const name = line.slice(0, idx).trim().toLowerCase();
		if (!name) continue;
		const value = trimAsciiWhitespace(line.slice(idx + 1));
		const existing = map.get(name);
		if (existing) existing.push(value);
		else map.set(name, [value]);
	}
	return map;
}

/** A header value parsed into its primary token plus its `; key=value` params. */
export interface StructuredHeader {
	/** The primary token, lowercased (e.g. `multipart/mixed`, `attachment`). */
	value: string;
	/** Parameters keyed by lowercased name (e.g. `boundary`, `report-type`). */
	params: Record<string, string>;
}

/**
 * Parse a structured header value of the form `value; k1=v1; k2="v2"`, as used
 * by `Content-Type` and `Content-Disposition`. RFC 2231 continuations
 * (`name*0`, `name*1*`) are reassembled and percent-decoded; RFC 2047 encoded
 * words in a plain (non-2231) param value are decoded. The primary `value` is
 * lowercased; param names are lowercased; param values keep their case.
 */
export function parseStructuredHeader(raw: string | undefined): StructuredHeader {
	const unfolded = unfold(raw ?? '').trim();
	const semi = unfolded.indexOf(';');
	const value = (semi < 0 ? unfolded : unfolded.slice(0, semi)).trim().toLowerCase();
	const params: Record<string, string> = {};
	if (semi < 0) return { value, params };

	// Collect continuation segments per base name before joining, so `name*1`
	// can't clobber `name*0`.
	const segments = new Map<string, Map<number, { text: string; extended: boolean }>>();
	const simple = new Map<string, string>();

	const paramRe = /;[ \t]*([^\s=;]+?)(\*(\d+))?(\*)?[ \t]*=[ \t]*("([^"]*)"|[^;\r\n]*)/g;
	let m: RegExpExecArray | null;
	while ((m = paramRe.exec(unfolded))) {
		const rawName = (m[1] ?? '').toLowerCase();
		if (!rawName) continue;
		// A quoted value keeps its interior whitespace verbatim (significant for
		// RFC 2231 continuations); a bare value is trimmed of layout whitespace.
		const rawValue = m[6] !== undefined ? m[6] : (m[5] ?? '').trim();
		const hasIndex = m[3] !== undefined;
		// A trailing `*` (RFC 2231) marks the value as `charset'lang'pct-encoded`.
		const extended = m[4] !== undefined;
		if (hasIndex) {
			const idx = Number.parseInt(m[3]!, 10);
			if (idx > MAX_CONTINUATION_INDEX) continue;
			let byIdx = segments.get(rawName);
			if (!byIdx) {
				byIdx = new Map();
				segments.set(rawName, byIdx);
			}
			byIdx.set(idx, { text: rawValue, extended });
		} else {
			simple.set(rawName, extended ? decodeRfc2231(rawValue) : decodeEncodedWords(rawValue));
		}
	}

	for (const [name, byIdx] of segments) {
		const ordered = [...byIdx.keys()].sort((a, b) => a - b);
		let joined = '';
		let anyExtended = false;
		for (const i of ordered) {
			const seg = byIdx.get(i)!;
			joined += seg.text;
			if (seg.extended) anyExtended = true;
		}
		params[name] = anyExtended ? decodeRfc2231(joined) : decodeEncodedWords(joined);
	}
	for (const [name, v] of simple) {
		if (!(name in params)) params[name] = v;
	}
	return { value, params };
}

/**
 * A parsed message header block: a case-insensitive multimap over the raw
 * (unfolded) header values, with structured accessors for the MIME headers.
 */
export class MessageHeaders {
	private readonly map: Map<string, string[]>;

	constructor(headerBlock: string) {
		this.map = splitHeaderLines(headerBlock);
	}

	/** First raw value for `name` (case-insensitive), or `undefined`. */
	get(name: string): string | undefined {
		return this.map.get(name.toLowerCase())?.[0];
	}

	/**
	 * LAST raw value for `name` (case-insensitive), or `undefined`.
	 *
	 * This is the effective value of a duplicated MIME header: a repeated
	 * `Content-Type` / `Content-Disposition` / `Content-Transfer-Encoding` /
	 * `Content-ID` resolves to its LAST occurrence. The walker reads those four
	 * headers via `last`, so every reader built on it resolves duplicate-header
	 * shapes the same way and the stored `partIndex` numbering stays stable.
	 * (Display/trace headers keep using {@link get}/{@link getAll}.)
	 */
	last(name: string): string | undefined {
		const values = this.map.get(name.toLowerCase());
		return values?.[values.length - 1];
	}

	/** Every raw value for `name` in document order. */
	getAll(name: string): string[] {
		return this.map.get(name.toLowerCase()) ?? [];
	}

	/**
	 * First value as one line of display text (for display headers like
	 * Subject): see {@link decodeRawHeaderValue}.
	 */
	getDecoded(name: string): string | undefined {
		const raw = this.get(name);
		return raw === undefined ? undefined : decodeRawHeaderValue(raw);
	}

	/**
	 * LAST value as one line of display text ({@link decodeRawHeaderValue}).
	 * mailparser treats `subject` (and the other single-valued display headers)
	 * as `singleKeys` and collapses a duplicated header to the LAST occurrence via
	 * `map.set`, so a header-shadowing message must resolve to the same value on
	 * both sides.
	 */
	lastDecoded(name: string): string | undefined {
		const raw = this.last(name);
		return raw === undefined ? undefined : decodeRawHeaderValue(raw);
	}

	has(name: string): boolean {
		return this.map.has(name.toLowerCase());
	}

	/** All header names present, lowercased, in first-seen order. */
	names(): string[] {
		return [...this.map.keys()];
	}

	/**
	 * Structured `Content-Type`, defaulting to `text/plain` when absent. Delegates
	 * to {@link parseContentType} so there is a single code path for the RFC 2045
	 * default and callers also get the split `type`/`subtype`.
	 */
	get contentType(): ContentType {
		return parseContentType(this.last('content-type'));
	}

	/** Structured `Content-Disposition`, or `undefined` when absent. */
	get contentDisposition(): StructuredHeader | undefined {
		const raw = this.last('content-disposition');
		return raw === undefined ? undefined : parseStructuredHeader(raw);
	}
}

/** Parse a raw header block into a {@link MessageHeaders}. */
export function parseHeaders(headerBlock: string): MessageHeaders {
	return new MessageHeaders(headerBlock);
}
