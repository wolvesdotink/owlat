/** Thrown when a streamed response exceeds its byte budget. */
export class StreamByteLimitExceeded extends Error {}

/**
 * Read at most `maxBytes` of an untrusted byte stream.
 *
 * Network response bodies are attacker-controlled and `Response.text()` /
 * `arrayBuffer()` buffer the whole body before a caller can inspect its size.
 * This helper is the shared bounded reader for server-side fetch and webhook
 * paths that need the actual bytes. Throws {@link StreamByteLimitExceeded} as
 * soon as the stream goes past the cap.
 */
export async function readStreamBytes(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number
): Promise<Uint8Array<ArrayBuffer> | null> {
	const prefix = await readStreamPrefix(body, maxBytes);
	if (prefix === null) return null;
	if (prefix.truncated) throw new StreamByteLimitExceeded(`response exceeds ${maxBytes} bytes`);
	return prefix.bytes;
}

/**
 * Read at most `maxBytes` real octets from an untrusted body stream and stop:
 * the bytes past the cap are never buffered and the stream is cancelled, so a
 * huge or never-ending body costs at most `maxBytes` of memory. With
 * `timeoutMs`, a producer that stalls also ends the read (as `truncated`)
 * instead of holding the caller until the transport gives up. A stream error
 * propagates.
 *
 * This is the one bounded reader: {@link readStreamBytes} here and the
 * backend's `readCappedBytes` / `readBodyPreview` (convex/lib/ssrfGuard.ts)
 * are built on it. `truncated` is true when reading stopped before the
 * producer finished (more than `maxBytes` arrived, or the time budget ran
 * out); the stream is cancelled in both cases.
 */
export async function readStreamPrefix(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	opts: { timeoutMs?: number } = {}
): Promise<{ bytes: Uint8Array<ArrayBuffer>; truncated: boolean } | null> {
	if (!body) return null;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new RangeError('maxBytes must be a non-negative safe integer');
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired =
		opts.timeoutMs === undefined
			? undefined
			: new Promise<'expired'>((resolve) => {
					timer = setTimeout(() => resolve('expired'), opts.timeoutMs);
				});
	try {
		for (;;) {
			const next = reader.read();
			const step = expired ? await Promise.race([next, expired]) : await next;
			if (step === 'expired') {
				// The pending read settles once cancel() lands; nothing awaits it.
				next.catch(() => undefined);
				truncated = true;
				break;
			}
			if (step.done) break;
			const chunk = step.value;
			if (!chunk) continue;
			const room = maxBytes - total;
			if (chunk.byteLength > room) {
				if (room > 0) chunks.push(chunk.subarray(0, room));
				total += Math.max(room, 0);
				truncated = true;
				break;
			}
			chunks.push(chunk);
			total += chunk.byteLength;
		}
	} finally {
		clearTimeout(timer);
		// Do not wait for an untrusted producer to acknowledge cancellation.
		if (truncated) void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
}
