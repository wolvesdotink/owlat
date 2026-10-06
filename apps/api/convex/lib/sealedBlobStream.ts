'use node';

/**
 * Read a stored blob and unseal it while it streams, into one array of its
 * plaintext size, for a Node action that reads a large blob (the forward copy
 * in `mail/draftExpectedAttachmentsFulfil.ts`). NODE ONLY: it decrypts with
 * `node:crypto`, so import it from `'use node'` modules alone.
 *
 * `readSealedBlobBytes` holds the whole blob several times over at once: its
 * `arrayBuffer()` copy, the envelope's ciphertext sliced out of it and copied
 * again, Web Crypto's copy of that input, and the plaintext. For a 50 MiB
 * message that is several hundred MiB. Here the blob's stream is read chunk
 * by chunk and each chunk is decrypted straight into the output, so the read
 * holds the stored blob and its plaintext and no more.
 *
 * SAME ENVELOPE, SAME ANSWERS as `readSealedBlobBytes` / `openBytesAtRest`
 * (`lib/atRestBodies.ts`): `MAGIC ‖ version ‖ iv(12) ‖ ciphertext ‖ tag(16)`,
 * AES-256-GCM under the HKDF-SHA-256 key of the instance secret with the blob
 * salt and info. A blob without the magic is plaintext and read verbatim, as is
 * every blob when no secret is configured; a blob that claims the magic but is
 * not a well-formed envelope, or whose tag does not verify, throws.
 * `sealedBlobStream.test.ts` holds the two readers to the same bytes.
 */
import { createDecipheriv, hkdfSync } from 'node:crypto';
import type { Id } from '../_generated/dataModel';
import { BLOB_HKDF_INFO, BLOB_HKDF_SALT, BLOB_MAGIC, BLOB_VERSION } from './atRestBodies';
import { GCM_TAG_BYTES, IV_BYTES } from './webSecretBox';
import type { BlobGet } from './sealedBlob';

const HEADER_BYTES = BLOB_MAGIC.length + 1 + IV_BYTES;

function hasMagic(bytes: Uint8Array): boolean {
	return BLOB_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** Read a blob's first `n` bytes (fewer when it is shorter) without reading the rest. */
async function head(blob: Blob, n: number): Promise<Uint8Array> {
	return new Uint8Array(await blob.slice(0, n).arrayBuffer());
}

/** Stream `blob` from `from` to `to`, handing each chunk to `use`. */
async function streamRange(
	blob: Blob,
	from: number,
	to: number,
	use: (chunk: Uint8Array) => void
): Promise<void> {
	const reader = blob.slice(from, to).stream().getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		use(value);
	}
}

/**
 * The plaintext bytes of a stored blob (see the module comment), or null when
 * the blob is missing. `secret` is the instance secret, or undefined when none
 * is configured.
 */
export async function readSealedBlobBytesStreaming(
	storage: BlobGet,
	storageId: Id<'_storage'>,
	secret: string | undefined
): Promise<Uint8Array | null> {
	const blob = await storage.get(storageId);
	if (!blob) return null;
	const size = blob.size;
	const start = await head(blob, HEADER_BYTES);
	const claimsMagic = start.length >= BLOB_MAGIC.length && hasMagic(start);
	const wellFormed =
		claimsMagic &&
		start[BLOB_MAGIC.length] === BLOB_VERSION &&
		size >= HEADER_BYTES + GCM_TAG_BYTES;
	if (claimsMagic && !wellFormed) throw new Error('Stored blob has a corrupt at-rest envelope');

	if (!wellFormed || secret === undefined) {
		const out = new Uint8Array(size);
		let at = 0;
		await streamRange(blob, 0, size, (chunk) => {
			out.set(chunk, at);
			at += chunk.length;
		});
		return out;
	}

	const iv = start.subarray(BLOB_MAGIC.length + 1, HEADER_BYTES);
	const tag = await head(blob.slice(size - GCM_TAG_BYTES, size), GCM_TAG_BYTES);
	const key = Buffer.from(
		hkdfSync('sha256', secret, BLOB_HKDF_SALT, BLOB_HKDF_INFO, 32) as ArrayBuffer
	);
	const decipher = createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);
	const out = new Uint8Array(size - HEADER_BYTES - GCM_TAG_BYTES);
	let at = 0;
	await streamRange(blob, HEADER_BYTES, size - GCM_TAG_BYTES, (chunk) => {
		const plain = decipher.update(chunk);
		out.set(plain, at);
		at += plain.length;
	});
	const last = decipher.final();
	out.set(last, at);
	return out;
}
