/** Regression tests for the storage-blob backfill's keyed idempotency check. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import { openBytesAtRest, sealBytesAtRest } from '../atRestBodies';
import { resealStoredBlob, type BlobGet, type BlobStore } from '../sealedBlob';

const SECRET = 'unit-test-instance-secret-value';
const SOURCE_ID = 'source' as Id<'_storage'>;
const SEALED_ID = 'sealed' as Id<'_storage'>;

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', SECRET);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

function storageFor(source: Uint8Array) {
	let stored: Blob | null = null;
	const storage: BlobGet & BlobStore = {
		async get(id) {
			return id === SOURCE_ID ? new Blob([source as unknown as BlobPart]) : stored;
		},
		async store(blob) {
			stored = blob;
			return SEALED_ID;
		},
	};
	return { storage, stored: () => stored };
}

describe('resealStoredBlob', () => {
	it('seals magic-shaped legacy plaintext instead of skipping it', async () => {
		const canary = new TextEncoder().encode('legacy plaintext canary');
		const magicShaped = new Uint8Array([0x41, 0x52, 0x42, 0x4c, 0x42, 0x31, 0x01, ...canary]);
		const fake = storageFor(magicShaped);

		expect(await resealStoredBlob(fake.storage, SOURCE_ID)).toBe(SEALED_ID);
		const stored = fake.stored();
		expect(stored).not.toBeNull();
		const sealed = new Uint8Array(await stored!.arrayBuffer());
		expect(await openBytesAtRest(SECRET, sealed)).toEqual(magicShaped);
	});

	it('still skips ciphertext that authenticates under the instance key', async () => {
		const sealed = await sealBytesAtRest(SECRET, new TextEncoder().encode('already sealed'));
		const fake = storageFor(sealed);

		expect(await resealStoredBlob(fake.storage, SOURCE_ID)).toBeNull();
		expect(fake.stored()).toBeNull();
	});
});
