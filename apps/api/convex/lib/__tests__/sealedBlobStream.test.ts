/**
 * `readSealedBlobBytesStreaming` (the forward read's unseal-as-it-streams)
 * gives the same bytes and the same refusals as `readSealedBlobBytes` +
 * `openBytesAtRest`, for sealed, legacy-plaintext, corrupt and tampered blobs,
 * with and without a configured secret.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import { openBytesAtRest, sealBytesAtRest } from '../atRestBodies';
import { readSealedBlobBytesStreaming } from '../sealedBlobStream';
import { readSealedBlobBytes } from '../sealedBlob';

const SECRET = 'test-instance-secret';
const ID = 'kg_blob' as Id<'_storage'>;

function storage(bytes: Uint8Array | null) {
	return { get: async () => (bytes ? new Blob([bytes as BlobPart]) : null) };
}

const sample = (size: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 0xff);

/**
 * The index of the first byte where `a` and `b` differ (the shorter length
 * when one is a prefix of the other), or -1 when they are the same bytes.
 * `toEqual` walks a typed array element by element through its generic deep
 * equality, about 3 µs a byte under coverage, so four 1 MB comparisons outran
 * the 10 s test timeout on CI; `Buffer.equals` compares them natively.
 */
function firstDifference(a: Uint8Array, b: Uint8Array): number {
	const view = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view(a).equals(view(b))) return -1;
	const shorter = Math.min(a.length, b.length);
	for (let i = 0; i < shorter; i++) if (a[i] !== b[i]) return i;
	return shorter;
}

describe('readSealedBlobBytesStreaming', () => {
	it('unseals a sealed blob to the bytes openBytesAtRest gives, across chunk sizes', async () => {
		for (const size of [1, 15, 16, 17, 4096, 70_000, 1_000_003]) {
			const plain = sample(size);
			const sealed = await sealBytesAtRest(SECRET, plain);
			const streamed = await readSealedBlobBytesStreaming(storage(sealed), ID, SECRET);
			if (!streamed) throw new Error(`no bytes for a sealed ${size}-byte blob`);
			expect(firstDifference(streamed, await openBytesAtRest(SECRET, sealed))).toBe(-1);
			expect(firstDifference(streamed, plain)).toBe(-1);
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

	it('refuses an envelope whose tag was cut short, as openBytesAtRest does', async () => {
		const sealed = await sealBytesAtRest(SECRET, sample(3000));
		for (const cut of [4, 12, 16]) {
			const short = sealed.slice(0, sealed.length - cut);
			await expect(readSealedBlobBytesStreaming(storage(short), ID, SECRET)).rejects.toThrow();
			await expect(openBytesAtRest(SECRET, short)).rejects.toThrow();
		}
		// An envelope with room for no full tag at all is corrupt for both readers.
		const header = sealed.slice(0, 19 + 12);
		await expect(readSealedBlobBytesStreaming(storage(header), ID, SECRET)).rejects.toThrow(
			/corrupt/
		);
		vi.stubEnv('INSTANCE_SECRET', SECRET);
		try {
			await expect(readSealedBlobBytes(storage(header), ID)).rejects.toThrow(/corrupt/);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
