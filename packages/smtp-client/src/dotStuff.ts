/**
 * Streaming dot-stuffing encoder for the SMTP `DATA` payload (RFC 5321 §4.5.2).
 *
 * Three jobs, done in one pass so it is safe for multi-megabyte bodies:
 *   1. Newline normalisation — bare LF and bare CR are promoted to CRLF, so the
 *      wire form uses CRLF line endings exclusively.
 *   2. Dot-stuffing — a line that begins with `.` gets an extra leading `.`, so
 *      it can never be mistaken for the end-of-data marker.
 *   3. Termination — the payload is closed with `<CRLF>.<CRLF>`; if the body did
 *      not already end on a line boundary, a CRLF is inserted first.
 *
 * The encoder is a byte-level state machine and is chunk-boundary safe: feeding
 * a body split at any offset produces byte-identical output to feeding it whole
 * (a CR that lands at the end of one chunk is held until the next chunk decides
 * whether it was a CRLF pair or a lone CR).
 */

const CR = 0x0d;
const LF = 0x0a;
const DOT = 0x2e;

const CRLF_BYTES = Buffer.from('\r\n');
const TERMINATOR = Buffer.from('.\r\n');

export class DotStuffEncoder {
	private atLineStart = true;
	private sawCr = false;
	private finished = false;

	/** Encode one chunk of body bytes, returning the encoded output so far. */
	transform(chunk: Buffer): Buffer {
		if (this.finished) {
			throw new Error('DotStuffEncoder.transform called after final()');
		}
		// Worst case: every byte becomes two (CR->CRLF, or a stuffed dot).
		const out = Buffer.allocUnsafe(chunk.length * 2);
		let o = 0;
		for (let i = 0; i < chunk.length; i++) {
			const b = chunk[i] as number;
			if (this.sawCr) {
				// A CR was pending: it always closes a line (bare CR -> CRLF).
				this.sawCr = false;
				out[o++] = CR;
				out[o++] = LF;
				this.atLineStart = true;
				if (b === LF) {
					// This LF completes the CRLF pair; consume it silently.
					continue;
				}
				// Otherwise fall through and process `b` as a fresh byte.
			}
			if (b === CR) {
				this.sawCr = true;
				continue;
			}
			if (b === LF) {
				out[o++] = CR;
				out[o++] = LF;
				this.atLineStart = true;
				continue;
			}
			if (this.atLineStart && b === DOT) {
				out[o++] = DOT; // stuff the extra leading dot
			}
			out[o++] = b;
			this.atLineStart = false;
		}
		return out.subarray(0, o);
	}

	/** Flush any held CR, close the final line, and emit the terminator. */
	final(): Buffer {
		if (this.finished) {
			throw new Error('DotStuffEncoder.final called twice');
		}
		this.finished = true;
		const parts: Buffer[] = [];
		if (this.sawCr) {
			this.sawCr = false;
			parts.push(CRLF_BYTES);
			this.atLineStart = true;
		}
		if (!this.atLineStart) {
			// Body did not end on a line boundary — add one before the marker.
			parts.push(CRLF_BYTES);
			this.atLineStart = true;
		}
		parts.push(TERMINATOR);
		return Buffer.concat(parts);
	}
}

/**
 * Convenience one-shot: dot-stuff and terminate a whole body buffer or string.
 * Equivalent to feeding the whole body to a {@link DotStuffEncoder} then
 * calling `final()`.
 */
export function dotStuffMessage(body: Buffer | string): Buffer {
	const encoder = new DotStuffEncoder();
	const input = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
	const encoded = encoder.transform(input);
	const terminator = encoder.final();
	return Buffer.concat([encoded, terminator]);
}
