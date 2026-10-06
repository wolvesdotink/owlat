/**
 * `readSealedBlobBytesStreaming` (the forward read's unseal-as-it-streams)
 * gives the same bytes and the same refusals as `readSealedBlobBytes` +
 * `openBytesAtRest`, for sealed, legacy-plaintext, corrupt and tampered blobs,
 * with and without a configured secret.
 */
import { describe, expect, it } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import { openBytesAtRest, sealBytesAtRest } from '../atRestBodies';
import { readSealedBlobBytesStreaming } from '../sealedBlobStream';

const SECRET = 'test-instance-secret';
const ID = 'kg_blob' as Id<'_storage'>;

function storage(bytes: Uint8Array | null) {
	return { get: async () => (bytes ? new Blob([bytes as BlobPart]) : null) };
}

const sample = (size: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 0xff);

describe('readSealedBlobBytesStreaming', () => {
	it('unseals a sealed blob to the bytes openBytesAtRest gives, across chunk sizes', async () => {
		for (const size of [1, 15, 16, 17, 4096, 70_000, 1_000_003]) {
			const plain = sample(size);
			const sealed = await sealBytesAtRest(SECRET, plain);
			const streamed = await readSealedBlobBytesStreaming(storage(sealed), ID, SECRET);
			expect(streamed).toEqual(await openBytesAtRest(SECRET, sealed));
			expect(streamed).toEqual(plain);
		}
	});

	it('reads a plaintext blob verbatim, and every blob verbatim without a secret', async () => {
		const plain = sample(5000);
		expect(await readSealedBlobBytesStreaming(storage(plain), ID, SECRET)).toEqual(plain);
		const sealed = await sealBytesAtRest(SECRET, plain);
		expect(await readSealedBlobBytesStreaming(storage(sealed), ID, undefined)).toEqual(sealed);
	});

	it('refuses a corrupt envelope and a tampered one, and answers null for a missing blob', async () => {
		const sealed = await sealBytesAtRest(SECRET, sample(2000));
		const truncated = sealed.slice(0, 10);
		await expect(readSealedBlobBytesStreaming(storage(truncated), ID, SECRET)).rejects.toThrow(
			/corrupt/
		);
		const tampered = sealed.slice();
		tampered[tampered.length - 100] = (tampered[tampered.length - 100] ?? 0) ^ 0xff;
		await expect(readSealedBlobBytesStreaming(storage(tampered), ID, SECRET)).rejects.toThrow();
		await expect(openBytesAtRest(SECRET, tampered)).rejects.toThrow();
		expect(await readSealedBlobBytesStreaming(storage(null), ID, SECRET)).toBeNull();
	});
});
