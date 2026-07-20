/**
 * Reverse SMTP transparency / dot-stuffing (RFC 5321 §4.5.2).
 *
 * On the wire, any DATA line that begins with a period has an extra period
 * prepended by the sender, and the message is terminated by a line containing a
 * single period. The command loop strips the terminator before calling this;
 * {@link dotDecode} then removes exactly one leading period from every line that
 * starts with one, yielding the true message bytes.
 *
 * Operates on raw bytes (a `Buffer`), never on decoded text, so it is charset-
 * agnostic and cannot corrupt binary MIME parts. A "line" is delimited by LF
 * (0x0a); the preceding CR is left untouched. The first byte of the buffer is a
 * line start.
 */

const DOT = 0x2e; // '.'
const LF = 0x0a; // '\n'

/** Remove SMTP dot-stuffing from a raw DATA body (terminator already stripped). */
export function dotDecode(raw: Buffer): Buffer {
	// Fast path: no leading-dot lines at all → the input is already decoded.
	if (!hasStuffedLine(raw)) {
		return raw;
	}
	const out = Buffer.allocUnsafe(raw.length);
	let w = 0;
	let atLineStart = true;
	for (let i = 0; i < raw.length; i++) {
		const b = raw[i] as number;
		if (atLineStart && b === DOT) {
			// Drop exactly one stuffing dot; the rest of the line copies verbatim.
			atLineStart = false;
			continue;
		}
		out[w++] = b;
		atLineStart = b === LF;
	}
	return out.subarray(0, w);
}

/** True if any line begins with a period (i.e. there is stuffing to remove). */
function hasStuffedLine(raw: Buffer): boolean {
	if (raw.length > 0 && raw[0] === DOT) return true;
	let idx = raw.indexOf(LF);
	while (idx !== -1 && idx + 1 < raw.length) {
		if (raw[idx + 1] === DOT) return true;
		idx = raw.indexOf(LF, idx + 1);
	}
	return false;
}
