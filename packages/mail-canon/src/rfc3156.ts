/**
 * RFC 3156 §5 `multipart/signed` first-part extraction — BYTE-EXACT.
 *
 * A PGP/MIME detached signature is computed over the FIRST body part of the
 * `multipart/signed` entity exactly as it appears on the wire: its part
 * headers, its body in whatever `Content-Transfer-Encoding` it was transmitted
 * with, and CRLF line endings throughout (RFC 3156 §5, RFC 1847 §2.1). Any
 * decoding, re-encoding, or line-ending normalization before hashing breaks
 * verification, so this module never interprets the part — it only slices the
 * original bytes.
 *
 * Boundary arithmetic per RFC 2046 §5.1.1: a delimiter line is
 * `CRLF "--" boundary [transport-padding] CRLF`; the CRLF that PRECEDES the
 * delimiter belongs to the delimiter, not to the part. Inner boundaries of a
 * nested-multipart first part are inert here because only the OUTER boundary
 * is searched for.
 *
 * Dependency-free (node:buffer only), like the rest of `@owlat/mail-canon`, so
 * it stays consumable from Convex `'use node'` actions without a build cycle.
 */

import { Buffer } from 'node:buffer';

/** The byte-exact halves of an RFC 3156 `multipart/signed` entity. */
export interface Rfc3156SignedParts {
	/**
	 * The first body part — part headers + encoded body, CRLF and
	 * content-transfer-encoding preserved byte-for-byte. These are the exact
	 * bytes the detached signature covers.
	 */
	readonly signedPart: Uint8Array;
	/**
	 * The ASCII-armored detached signature carried by the
	 * `application/pgp-signature` second part (its transfer-encoding decoded —
	 * the armor itself is the signed artifact, unlike the first part).
	 */
	readonly signatureArmored: string;
	/** The outer `micalg` parameter, when present (e.g. `pgp-sha256`). */
	readonly micalg?: string;
}

/**
 * Extract the byte-exact signed first part + the armored detached signature
 * from a raw `multipart/signed` message. Returns `null` for any malformed
 * structure (not multipart/signed, missing boundary, fewer than two parts, or
 * a second part that is not an `application/pgp-signature` armor) — the caller
 * turns that into an honest "malformed" verdict, never a throw.
 */
export function extractRfc3156SignedPart(raw: Uint8Array): Rfc3156SignedParts | null {
	const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
	// latin1 maps bytes 1:1 to code units, so string search offsets ARE byte
	// offsets and slicing the original buffer stays byte-exact.
	const text = buf.toString('latin1');

	const headerEnd = text.indexOf('\r\n\r\n');
	if (headerEnd < 0) return null;
	const outerHeaders = text.slice(0, headerEnd);

	const contentType = headerValue(outerHeaders, 'content-type');
	if (!contentType || !/^multipart\/signed[\s;]/i.test(`${contentType};`)) return null;
	const boundary = parameterValue(contentType, 'boundary');
	if (!boundary) return null;
	const micalg = parameterValue(contentType, 'micalg');

	const bodyStart = headerEnd + 4;
	const delimiter = `\r\n--${boundary}`;

	// First delimiter: either the body's very first line or after a preamble.
	let firstPartStart: number;
	if (text.startsWith(`--${boundary}`, bodyStart)) {
		firstPartStart = endOfDelimiterLine(text, bodyStart + 2 + boundary.length);
	} else {
		const at = findDelimiter(text, delimiter, bodyStart);
		if (at < 0) return null;
		firstPartStart = endOfDelimiterLine(text, at + delimiter.length);
	}
	if (firstPartStart < 0) return null;

	// The delimiter closing the first part; its leading CRLF is NOT part bytes.
	const secondDelimiterAt = findDelimiter(text, delimiter, firstPartStart);
	if (secondDelimiterAt < 0) return null;
	const signedPart = buf.subarray(firstPartStart, secondDelimiterAt);

	const secondPartStart = endOfDelimiterLine(text, secondDelimiterAt + delimiter.length);
	if (secondPartStart < 0) return null;
	// The second part runs to the next delimiter (normally the close-delimiter
	// `--boundary--`); a missing close-delimiter is malformed.
	const thirdDelimiterAt = findDelimiter(text, delimiter, secondPartStart);
	if (thirdDelimiterAt < 0) return null;
	const signaturePart = text.slice(secondPartStart, thirdDelimiterAt);

	const signatureArmored = decodeSignaturePart(signaturePart);
	if (!signatureArmored) return null;

	return micalg ? { signedPart, signatureArmored, micalg } : { signedPart, signatureArmored };
}

/**
 * Locate the next TRUE delimiter occurrence at or after `from`: the delimiter
 * text followed by either a properly terminated line (transport-padding +
 * CRLF) or the close-delimiter's `--`. A body line that merely STARTS with the
 * delimiter text (`--boundary-extra`) is not a boundary and is skipped, per
 * RFC 2046 §5.1.1's exact-line rule.
 */
function findDelimiter(text: string, delimiter: string, from: number): number {
	let at = text.indexOf(delimiter, from);
	while (at >= 0) {
		let i = at + delimiter.length;
		if (text.startsWith('--', i)) return at;
		while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
		if (text.startsWith('\r\n', i)) return at;
		at = text.indexOf(delimiter, at + 1);
	}
	return -1;
}

/**
 * Position just past a delimiter line's terminating CRLF, skipping RFC 2046
 * transport-padding (WSP). Returns -1 when the line is not properly
 * terminated, or when this is the close-delimiter (`--boundary--`) — there is
 * no further part to start.
 */
function endOfDelimiterLine(text: string, afterBoundary: number): number {
	let i = afterBoundary;
	if (text.startsWith('--', i)) return -1; // close-delimiter: no part follows
	while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
	if (!text.startsWith('\r\n', i)) return -1;
	return i + 2;
}

/** A single unfolded header value (lower-cased name lookup) from a header block. */
function headerValue(headerBlock: string, name: string): string | undefined {
	const lines = headerBlock.split('\r\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		const colon = line.indexOf(':');
		if (colon < 0) continue;
		if (line.slice(0, colon).trim().toLowerCase() !== name) continue;
		let value = line.slice(colon + 1);
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j];
			if (next !== undefined && /^[ \t]/.test(next)) value += ` ${next.trim()}`;
			else break;
		}
		return value.trim();
	}
	return undefined;
}

/** A (possibly quoted) MIME parameter value from a header value. */
function parameterValue(headerVal: string, param: string): string | undefined {
	const re = new RegExp(`;\\s*${param}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i');
	const m = re.exec(headerVal);
	if (!m) return undefined;
	return (m[1] ?? m[2] ?? '').trim() || undefined;
}

/**
 * Pull the armored signature out of the second body part (part headers +
 * body). The part must declare `application/pgp-signature`; its body is
 * decoded per its `Content-Transfer-Encoding` — armor is 7bit ASCII, but some
 * senders ship it base64- or quoted-printable-encoded.
 */
function decodeSignaturePart(part: string): string | null {
	const headerEnd = part.indexOf('\r\n\r\n');
	const headerBlock = headerEnd >= 0 ? part.slice(0, headerEnd) : '';
	const body = headerEnd >= 0 ? part.slice(headerEnd + 4) : part;

	const contentType = headerValue(headerBlock, 'content-type') ?? '';
	if (!/^application\/pgp-signature\b/i.test(contentType)) return null;

	const cte = (headerValue(headerBlock, 'content-transfer-encoding') ?? '7bit').toLowerCase();
	let decoded: string;
	if (cte === 'base64') {
		decoded = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('latin1');
	} else if (cte === 'quoted-printable') {
		decoded = decodeQuotedPrintable(body);
	} else {
		decoded = body;
	}

	return decoded.includes('-----BEGIN PGP SIGNATURE-----') ? decoded : null;
}

/** Minimal RFC 2045 §6.7 quoted-printable decoding (soft breaks + =XX escapes). */
function decodeQuotedPrintable(body: string): string {
	return body
		.replace(/=\r\n/g, '')
		.replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
