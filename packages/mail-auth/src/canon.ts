/**
 * RFC 6376 §3.4 DKIM canonicalization — a PUBLIC API (locked decision D4).
 *
 * Both the inbound verifier (`dkim/verify.ts`) and the outbound signer
 * (repointed in piece A3), plus any future ARC implementation, consume this
 * ONE module so that signer and verifier canonicalize by construction the
 * same way. There is no second copy of these rules anywhere.
 *
 * Two canonicalization algorithms are defined for each of the header and body
 * halves (§3.4.1–§3.4.4):
 *
 *   - `simple`  — the message is (almost) untouched: headers verbatim, the
 *     body's trailing empty lines collapsed to a single CRLF.
 *   - `relaxed` — whitespace is normalized so that innocuous transport
 *     rewrites (folding, tab/space runs, trailing WSP) don't break the hash.
 *
 * Everything here operates on raw bytes (`Buffer`) so the output is
 * byte-identical to the reference implementation; the differential vector
 * suite pins that identity against `mailauth`.
 */

/** ASCII byte constants used by the byte-exact routines below. */
const CR = 0x0d;
const LF = 0x0a;
const CRLF = Buffer.from('\r\n', 'latin1');

/** The two canonicalization modes, per RFC 6376 §3.4. */
export type Canonicalization = 'simple' | 'relaxed';

/**
 * Parse a `c=` tag value (`header/body`, or a bare `header`) into its two
 * halves. A missing half defaults to `simple` per §3.5.
 */
export function parseCanonicalization(tag: string | undefined): {
	readonly header: Canonicalization;
	readonly body: Canonicalization;
} {
	const [rawHeader, rawBody] = (tag ?? '').split('/');
	const header = rawHeader === 'relaxed' ? 'relaxed' : 'simple';
	const body = rawBody === 'relaxed' ? 'relaxed' : 'simple';
	return { header, body };
}

/* -------------------------------------------------------------------------- */
/*  Header canonicalization (§3.4.1 simple, §3.4.2 relaxed)                    */
/* -------------------------------------------------------------------------- */

/**
 * Canonicalize a single header field.
 *
 * `field` is the complete raw header — field name, colon, value, and any
 * folded continuation lines — WITHOUT its terminating CRLF. The returned
 * string also carries no trailing CRLF; the caller joins fields with CRLF and
 * decides whether the trailing DKIM-Signature header gets one (it does not).
 *
 *   - `simple`  returns the field verbatim.
 *   - `relaxed` lowercases the name, unfolds continuations, collapses WSP
 *     runs to a single SP, and strips WSP around the colon and at end of value.
 */
export function canonicalizeHeaderField(field: string, mode: Canonicalization): string {
	if (mode === 'simple') {
		return field;
	}

	const colon = field.indexOf(':');
	if (colon === -1) {
		// Not a valid header field; relaxed lowercases what there is.
		return field.trim().toLowerCase();
	}

	const name = field
		.slice(0, colon)
		.replace(/[ \t]+$/, '')
		.toLowerCase();
	const value = field
		.slice(colon + 1)
		// Unfold: continuation CRLFs (and stray CR / LF) vanish.
		.replace(/\r\n|\r|\n/g, '')
		// Collapse every WSP run to a single SP.
		.replace(/[ \t]+/g, ' ')
		// Delete WSP immediately after the colon and at end of value.
		.replace(/^ /, '')
		.replace(/ $/, '');

	return `${name}:${value}`;
}

/**
 * Remove the `b=` (signature) value from a DKIM-Signature header, keeping the
 * `b=` tag and structure intact. RFC 6376 §3.7: the signature header is hashed
 * with its own `b=` value emptied. Works on the raw (possibly folded) header.
 */
export function stripSignatureValue(field: string): string {
	// Anchor on a TAG boundary — start-of-string or a `;` — so we never mistake
	// a `b=` that happens to fall at the tail of another tag's base64 value
	// (e.g. `bh=…b=`) for the signature tag. Blank everything from the `=` up to
	// the next `;` or end of string; folded (CRLF/WSP) values are included.
	return field.replace(/(^|;)([ \t\r\n]*b[ \t]*=)[^;]*/i, '$1$2');
}

/* -------------------------------------------------------------------------- */
/*  Body canonicalization (§3.4.3 simple, §3.4.4 relaxed)                      */
/* -------------------------------------------------------------------------- */

/**
 * Strip the trailing run of line-break bytes from `body`, returning the offset
 * of the first byte that is NOT part of that run.
 *
 * mailauth / OpenDKIM strip EVERY trailing CR or LF byte (not just complete
 * CRLF pairs) before re-terminating with a single CRLF, so an LF-normalized
 * body (`'a\nb\n'`) canonicalizes to `'a\nb\r\n'` and `'x\n\n\n'` to `'x\r\n'`.
 * Stripping only `\r\n` pairs would leave a stray `\n` in the hash and diverge
 * from the oracle on bare-LF mail; the byte-identity vector suite pins this.
 */
function stripTrailingCrlf(body: Buffer): number {
	let end = body.length;
	while (end > 0) {
		const b = body[end - 1];
		if (b !== CR && b !== LF) {
			break;
		}
		end -= 1;
	}
	return end;
}

/**
 * Simple body canonicalization (§3.4.3): ignore all trailing empty lines,
 * then ensure the body ends with exactly one CRLF. An empty body canonicalizes
 * to a single CRLF. No other bytes change.
 */
export function canonicalizeBodySimple(body: Buffer): Buffer {
	const end = stripTrailingCrlf(body);
	return Buffer.concat([body.subarray(0, end), CRLF]);
}

/**
 * Relaxed body canonicalization (§3.4.4):
 *   - reduce every WSP run within a line to a single SP,
 *   - strip WSP at the end of each line,
 *   - ignore all trailing empty lines.
 *
 * Unlike `simple`, an EMPTY canonical body stays empty (no CRLF is added) —
 * this asymmetry is part of the standard and is pinned by the vector suite.
 */
export function canonicalizeBodyRelaxed(body: Buffer): Buffer {
	// Operate on a byte-preserving latin1 view so regexes are byte-exact.
	const lines = body.toString('latin1').split('\n');
	const out: string[] = [];
	for (const raw of lines) {
		const line = (raw.endsWith('\r') ? raw.slice(0, -1) : raw)
			.replace(/[ \t]+/g, ' ')
			.replace(/ $/, '');
		out.push(line);
	}
	// Drop trailing empty lines (§3.4.4). The final split element is the tail
	// after the last LF and is empty for a normally CRLF-terminated body.
	while (out.length > 0 && out[out.length - 1] === '') {
		out.pop();
	}
	if (out.length === 0) {
		return Buffer.alloc(0);
	}
	return Buffer.from(`${out.join('\r\n')}\r\n`, 'latin1');
}

/** Dispatch body canonicalization by mode. */
export function canonicalizeBody(body: Buffer, mode: Canonicalization): Buffer {
	return mode === 'relaxed' ? canonicalizeBodyRelaxed(body) : canonicalizeBodySimple(body);
}
