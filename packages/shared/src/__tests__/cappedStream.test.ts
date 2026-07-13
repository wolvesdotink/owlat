import { describe, expect, it } from 'vitest';
import { readStreamBytes, StreamByteLimitExceeded } from '../cappedStream';

function streamChunks(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

describe('readStreamBytes', () => {
	it('combines chunks up to the exact byte limit', async () => {
		const bytes = await readStreamBytes(
			streamChunks(new Uint8Array([1, 2]), new Uint8Array([3, 4])),
			4
		);
		expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
	});

	it('stops reading as soon as the byte limit is exceeded', async () => {
		await expect(
			readStreamBytes(streamChunks(new Uint8Array([1, 2]), new Uint8Array([3])), 2)
		).rejects.toBeInstanceOf(StreamByteLimitExceeded);
	});

	it('returns null for an absent body and rejects invalid limits', async () => {
		await expect(readStreamBytes(null, 1)).resolves.toBeNull();
		await expect(readStreamBytes(streamChunks(), -1)).rejects.toBeInstanceOf(RangeError);
	});
});
