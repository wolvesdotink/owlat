/** Thrown when a streamed response exceeds its byte budget. */
export class StreamByteLimitExceeded extends Error {}

/**
 * Read at most `maxBytes` of an untrusted byte stream.
 *
 * Network response bodies are attacker-controlled and `Response.text()` /
 * `arrayBuffer()` buffer the whole body before a caller can inspect its size.
 * This helper is the shared bounded reader for server-side fetch and webhook
 * paths that need the actual bytes.
 */
export async function readStreamBytes(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number
): Promise<Uint8Array | null> {
	if (!body) return null;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new RangeError('maxBytes must be a non-negative safe integer');
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new StreamByteLimitExceeded(`response exceeds ${maxBytes} bytes`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
