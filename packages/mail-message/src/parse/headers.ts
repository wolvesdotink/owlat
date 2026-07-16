/**
 * RFC 5322 / RFC 2047 / RFC 2231 header primitives.
 *
 * This is the canonical home of the header helpers that previously lived
 * (unexported except for `decodeEncodedWords`) inside
 * `packages/shared/src/mailMime.ts`. That module now re-exports these so every
 * existing importer keeps working unchanged while the in-house mail-message
 * parser builds on top of them.
 *
 * `unfold`, `decodeEncodedWords` and `decodeRfc2231` are relocated
 * byte-for-byte from mailMime — no behavior change — so the shared mailMime
 * attachment extractor stays semantically identical.
 */

import { parseContentType, type ContentType } from './contentType';

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
 * Decode RFC 2047 encoded-words (`=?charset?B|Q?payload?=`), honoring the
 * DECLARED charset. Falls back utf-8 → raw payload when the charset is
 * unknown. Relocated byte-for-byte from mailMime; the shared shim re-exports
 * this exact function.
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
					return new TextDecoder(cs).decode(bytes);
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

/**
 * Decode an RFC 2231 extended parameter value (`charset'lang'pct-encoded`),
 * falling back to the raw value when there is no language/charset prefix or
 * the percent-decode fails. Relocated byte-for-byte from mailMime.
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
 * Extract a structured-header param by name from a RAW header value.
 *
 * The `(?:^|[;\s])` anchor matches a param introduced after ANY whitespace, not
 * only after a `;`, so real broken generators that emit
 * `Content-Disposition: attachment filename="x"` or
 * `Content-Type: multipart/mixed boundary="B"` (no semicolon) are read the same
 * way here as by the current `mailMime` extractor. RFC 2231 continuations
 * (`name*0`, `name*1*`) are reassembled and percent-decoded.
 *
 * This is the single home of the whitespace-anchored param scanner: both the
 * in-house MIME walker (boundary/filename/disposition extraction) and the shared
 * `mailMime` attachment extractor consume it, so both sides read params
 * identically by construction.
 */
export function getRawParam(headerValue: string | undefined, name: string): string | undefined {
	if (!headerValue) return undefined;
	const continued: string[] = [];
	const contRe = new RegExp(
		`(?:^|[;\\s])${name}\\*(\\d+)\\*?\\s*=\\s*("([^"]*)"|([^;\\r\\n]+))`,
		'gi'
	);
	let cm: RegExpExecArray | null;
	while ((cm = contRe.exec(headerValue))) {
		continued[Number.parseInt(cm[1]!, 10)] = (cm[3] ?? cm[4] ?? '').trim();
	}
	if (continued.length > 0) return decodeRfc2231(continued.join(''));
	const re = new RegExp(`(?:^|[;\\s])${name}\\*?\\s*=\\s*("([^"]*)"|([^;\\r\\n]+))`, 'i');
	const m = headerValue.match(re);
	const value = m ? (m[2] ?? m[3] ?? '') : undefined;
	return value ? decodeRfc2231(value.trim()) : undefined;
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
		const value = line.slice(idx + 1).trim();
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

	/** Every raw value for `name` in document order. */
	getAll(name: string): string[] {
		return this.map.get(name.toLowerCase()) ?? [];
	}

	/** First value decoded through RFC 2047 (for display headers like Subject). */
	getDecoded(name: string): string | undefined {
		const raw = this.get(name);
		return raw === undefined ? undefined : decodeHeaderValue(raw);
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
		return parseContentType(this.get('content-type'));
	}

	/** Structured `Content-Disposition`, or `undefined` when absent. */
	get contentDisposition(): StructuredHeader | undefined {
		const raw = this.get('content-disposition');
		return raw === undefined ? undefined : parseStructuredHeader(raw);
	}
}

/** Parse a raw header block into a {@link MessageHeaders}. */
export function parseHeaders(headerBlock: string): MessageHeaders {
	return new MessageHeaders(headerBlock);
}
