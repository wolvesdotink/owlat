/**
 * RFC 2045 body encoding: quoted-printable, 7bit/QP selection, and MIME
 * boundary generation. Pure and deterministic except for `randomBoundary`,
 * whose only impurity is `node:crypto` random bytes.
 */

import { randomBytes } from 'node:crypto';

export function randomBoundary(): string {
	// crypto-random so a hostile body cannot collide with the boundary
	return `--_owlat_${randomBytes(12).toString('hex')}`;
}

/**
 * Quoted-printable encode per RFC 2045 §6.7.
 *
 * The input is CRLF-normalized first so that hard line breaks are preserved as
 * CRLF and any bare CR/LF the renderer produced is canonicalised. Every output
 * line is kept to at most 76 octets via soft (`=`-terminated) line breaks, which
 * also keeps us comfortably under the RFC 5322 §2.1.1 998-octet hard limit.
 */
export function quotedPrintableEncode(input: string): string {
	// Canonicalise all line endings to CRLF first.
	const normalized = input.replace(/\r\n|\r|\n/g, '\n');
	const lines = normalized.split('\n');
	const out: string[] = [];

	for (const line of lines) {
		const bytes = Buffer.from(line, 'utf-8');
		const tokens: string[] = [];
		for (let i = 0; i < bytes.length; i++) {
			const b = bytes[i]!;
			const isLast = i === bytes.length - 1;
			// Printable ASCII except '=' (0x3D) is literal. Space/tab are literal
			// unless they fall at end of line (then they must be encoded).
			if (b === 0x3d) {
				tokens.push('=3D');
			} else if (b === 0x09 || b === 0x20) {
				tokens.push(isLast ? (b === 0x09 ? '=09' : '=20') : String.fromCharCode(b));
			} else if (b >= 0x21 && b <= 0x7e) {
				tokens.push(String.fromCharCode(b));
			} else {
				tokens.push(`=${b.toString(16).toUpperCase().padStart(2, '0')}`);
			}
		}

		// Fold into <=76-octet output lines using soft line breaks ("=\r\n").
		// A soft break and any escape sequence must never be split, so we track
		// the current line length and break before a token would overflow.
		//
		// RFC 2045 §6.7 rule (3): whitespace must not appear at the end of an
		// encoded line, *including* immediately before a soft line break. Space
		// and tab are emitted literally above (they're only encoded when they're
		// the last byte of the input line), so folding can push a literal space
		// or tab to the end of an output line right before the '='. A
		// whitespace-trimming relay would strip it and corrupt the body / break
		// DKIM, so escape any trailing literal space/tab before the soft break.
		//
		// That whitespace->'=20'/'=09' rewrite grows the line by 2 octets (1 char
		// becomes 3), so we fold at 73 (not 75): worst case a 73-octet `current`
		// ending in a literal space becomes 75 octets after the rewrite, then the
		// trailing '=' brings the physical line to exactly 76 — the RFC 2045 cap.
		let current = '';
		const pushSoftBreak = () => {
			if (current.endsWith(' ')) {
				current = `${current.slice(0, -1)}=20`;
			} else if (current.endsWith('\t')) {
				current = `${current.slice(0, -1)}=09`;
			}
			out.push(current + '=');
			current = '';
		};
		for (const tok of tokens) {
			if (current.length + tok.length > 73) {
				pushSoftBreak();
			}
			current += tok;
		}
		out.push(current);
	}

	return out.join('\r\n');
}

/**
 * Choose a Content-Transfer-Encoding for a text body and return the encoded
 * bytes alongside the CTE token.
 *
 * - Pure-ASCII bodies whose every CRLF-delimited line is <=998 octets stay
 *   7bit (CRLF-normalized) so the common case is human-readable on the wire.
 * - Everything else (non-ASCII, or an over-long line) is quoted-printable,
 *   which guarantees <=76 octets per line and round-trips non-ASCII safely.
 *
 * 8bit is never emitted: it breaks on non-8BITMIME relays (RFC 6152) and a
 * single-line render trivially exceeds the 998-octet line cap (RFC 5322
 * §2.1.1).
 */
export function encodeTextBody(body: string): {
	cte: '7bit' | 'quoted-printable';
	encoded: string;
} {
	const normalized = body.replace(/\r\n|\r|\n/g, '\r\n');
	// eslint-disable-next-line no-control-regex
	const isAscii = /^[\x00-\x7F]*$/.test(normalized);
	const lineSafe = normalized
		.split('\r\n')
		.every((line) => Buffer.byteLength(line, 'utf-8') <= 998);
	if (isAscii && lineSafe) {
		return { cte: '7bit', encoded: normalized };
	}
	return { cte: 'quoted-printable', encoded: quotedPrintableEncode(body) };
}
