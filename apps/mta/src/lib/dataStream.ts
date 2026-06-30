import type { Readable } from 'node:stream';

/**
 * Collect an SMTP DATA stream into a Buffer with a hard byte budget.
 *
 * smtp-server's `size` option only *advertises* EHLO SIZE and validates the
 * client's declared `MAIL FROM ... SIZE=` parameter — it does NOT enforce the
 * number of bytes actually streamed. A client that omits SIZE= (or lies) can
 * stream gigabytes, and naive `Buffer.concat`/`simpleParser(stream)` handling
 * grows process memory without bound. Pre-auth, that is a trivial remote
 * memory-exhaustion DoS against the public MX.
 *
 * Behaviour:
 *  - Within budget: resolves `{ ok: true, buffer }`.
 *  - Over budget: stops buffering (memory stays bounded at `maxBytes`),
 *    keeps draining so the SMTP dialogue can answer with a clean 552 …
 *  - … unless the sender keeps pushing past `abortFactor × maxBytes`, at
 *    which point the stream is destroyed outright to also bound bandwidth.
 */
export async function collectDataStream(
	stream: Readable & { sizeExceeded?: boolean },
	maxBytes: number,
	abortFactor = 4,
): Promise<{ ok: true; buffer: Buffer } | { ok: false }> {
	const chunks: Buffer[] = [];
	let total = 0;
	let exceeded = false;

	for await (const chunk of stream) {
		const buf = chunk as Buffer;
		total += buf.length;
		if (!exceeded && total <= maxBytes) {
			chunks.push(buf);
			continue;
		}
		if (!exceeded) {
			exceeded = true;
			chunks.length = 0; // release what we buffered so far
		}
		if (total > maxBytes * abortFactor) {
			stream.destroy();
			return { ok: false };
		}
	}

	// smtp-server flags declared-size violations itself; honor that too.
	if (exceeded || stream.sizeExceeded) {
		return { ok: false };
	}
	return { ok: true, buffer: Buffer.concat(chunks) };
}

/** SMTP 552: requested mail action aborted, exceeded storage allocation. */
export function messageTooLargeError(maxBytes: number): Error & { responseCode: number } {
	const err = new Error(
		`Message exceeds maximum size of ${Math.floor(maxBytes / (1024 * 1024))}MB`,
	) as Error & { responseCode: number };
	err.responseCode = 552;
	return err;
}
