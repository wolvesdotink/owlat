/**
 * sealedBlob — sealing + decrypt-SERVING for STORAGE BLOBS at rest (Sealed Mail
 * E8b). The companion to `lib/atRestBodies.ts`'s byte cipher: this module owns
 * the two places a storage blob crosses the trust boundary.
 *
 * WHY A SEPARATE SERVING PATH. The four inline body COLUMNS are read back
 * through `lib/messageBody.ts` and decrypted in-process, so nothing outside
 * Convex ever sees them. Storage BLOBS are different — the raw `.eml`
 * (`rawStorageId`) and the large-body blobs (`*BodyStorageId`) are handed to
 * out-of-process consumers as bare, time-limited SIGNED URLS:
 *   - the Postbox web reader `fetch()`es the body/raw URL for render + download,
 *   - the out-of-process IMAP bridge streams `FETCH RFC822` from the raw URL,
 *   - the outbound MTA / external-SMTP worker fetches the raw `.eml` to transmit
 *     (and to APPEND the sent copy remotely).
 * If we sealed the blob in place and kept handing out `ctx.storage.getUrl`, each
 * of those consumers would receive CIPHERTEXT — a broken render and, worse, a
 * broken send. So the blob is sealed at rest and a DECRYPT-SERVING PROXY sits in
 * front of it: instead of the raw storage URL, callers mint a URL to the Convex
 * HTTP action {@link (see mail/sealedBlobHttp)} which reads the sealed blob,
 * unseals it, and streams PLAINTEXT bytes. Every consumer keeps doing exactly
 * what it did — a plain `GET` that yields the original bytes — so the proxy is a
 * transparent drop-in and no out-of-process code changes.
 *
 * ACCESS CONTROL. The minting site has already authorized the caller (mailbox
 * ownership is checked before a URL is ever returned). The proxy URL therefore
 * carries a capability token — an HMAC over `storageId . contentType . expiry`
 * keyed by `INSTANCE_SECRET` — that the proxy verifies before serving, and that
 * expires, exactly matching the unguessable, time-limited nature of the Convex
 * signed URL it replaces.
 *
 * MIXED-STATE TOLERANCE. `openBytesAtRest` passes a legacy (unsealed) blob
 * through verbatim, so the proxy serves a not-yet-migrated blob correctly too —
 * the store can hold a mix of sealed and plaintext blobs during the back-fill.
 *
 * FALLBACK. Sealing only happens when `INSTANCE_SECRET` is configured, so a blob
 * is only ever ciphertext on an instance that HAS the key. When either the
 * secret or `CONVEX_SITE_URL` is absent, {@link sealedBlobUrl} falls back to the
 * direct signed URL — the blob is plaintext in that case, so a bare URL is
 * correct and nothing regresses on an unprovisioned install.
 */

import type { Id } from '../_generated/dataModel';
import { getOptional } from './env';
import { sealBytesAtRest, openBytesAtRest } from './atRestBodies';

/** Proxy route path (registered in `http.ts`). */
export const SEALED_BLOB_PATH = '/sealed-blob';
/** How long a minted proxy URL stays valid. Matches the short-lived nature of a
 * Convex signed storage URL; long enough for a reader fetch or an MTA transmit. */
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const encoder = new TextEncoder();

/** Minimal storage surface for STORING a blob (action/mutation `ctx.storage`). */
export interface BlobStore {
	store(blob: Blob): Promise<Id<'_storage'>>;
}
/** Minimal storage surface for READING a blob's bytes (action/mutation ctx). */
export interface BlobGet {
	get(storageId: Id<'_storage'>): Promise<Blob | null>;
}
/** Minimal storage surface for minting a signed URL (query/mutation/action ctx). */
export interface BlobGetUrl {
	getUrl(storageId: Id<'_storage'>): Promise<string | null>;
}

/** base64url without padding — matches the tracking-HMAC encoding used elsewhere. */
function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time string compare for the capability token. */
function timingSafeStrEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return mismatch === 0;
}

async function hmac(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
	return bytesToBase64Url(new Uint8Array(mac));
}

/**
 * Domain-separation label for the capability-token HMAC. Per the brief's
 * distinct-domain-per-use rule, the token is signed over a context-prefixed
 * message so a raw-`INSTANCE_SECRET` HMAC from this use can never collide with
 * an HMAC minted for any other purpose (tracking, MTA-webhook verify, …).
 */
const TOKEN_CONTEXT = 'owlat:sealed-blob:token:v1:';

/** The signed message that binds a token to its blob, content-type, and expiry. */
function tokenMessage(storageId: string, contentType: string, exp: number): string {
	return `${TOKEN_CONTEXT}${storageId}.${contentType}.${exp}`;
}

/**
 * Seal blob bytes at rest and store them, returning the storage id. When no
 * `INSTANCE_SECRET` is configured the plaintext bytes are stored unchanged
 * (mirrors {@link sealBodyAtWrite} — an instance cannot seal without a key, and
 * without a key a plaintext store is exactly today's behaviour).
 */
export async function storeSealedBlob(
	storage: BlobStore,
	bytes: Uint8Array,
	contentType: string
): Promise<Id<'_storage'>> {
	const secret = getOptional('INSTANCE_SECRET');
	const out = secret === undefined ? bytes : await sealBytesAtRest(secret, bytes);
	// `BlobPart` typings reject Uint8Array<ArrayBufferLike> under newer
	// @types/node; the runtime accepts it. Cast through unknown.
	return storage.store(new Blob([out as unknown as BlobPart], { type: contentType }));
}

/**
 * Read a stored blob and UNSEAL its bytes. A legacy (unsealed) blob passes
 * through verbatim. Returns `null` when the blob is missing.
 */
export async function readSealedBlobBytes(
	storage: BlobGet,
	storageId: Id<'_storage'>
): Promise<Uint8Array | null> {
	const blob = await storage.get(storageId);
	if (!blob) return null;
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const secret = getOptional('INSTANCE_SECRET');
	if (secret === undefined) return bytes;
	return openBytesAtRest(secret, bytes);
}

/**
 * Read a stored blob, unseal it, and decode as UTF-8 text. For the text/html
 * body blobs (which hold UTF-8 message bodies). Returns `''` when missing.
 */
export async function readSealedBlobText(
	storage: BlobGet,
	storageId: Id<'_storage'>
): Promise<string> {
	const bytes = await readSealedBlobBytes(storage, storageId);
	return bytes === null ? '' : new TextDecoder().decode(bytes);
}

/**
 * Mint a URL a consumer can fetch to get the blob's PLAINTEXT bytes. When the
 * instance has a key and a site URL, this is the decrypt-serving proxy URL
 * (capability token bound to the blob + content-type + expiry). Otherwise the
 * blob is plaintext at rest, so we fall back to the direct signed storage URL.
 */
export async function sealedBlobUrl(
	storage: BlobGetUrl,
	storageId: Id<'_storage'>,
	contentType: string
): Promise<string | null> {
	const secret = getOptional('INSTANCE_SECRET');
	const siteUrl = getOptional('CONVEX_SITE_URL');
	if (secret === undefined || siteUrl === undefined) {
		return storage.getUrl(storageId);
	}
	const exp = Date.now() + TOKEN_TTL_MS;
	const sig = await hmac(secret, tokenMessage(storageId, contentType, exp));
	const params = new URLSearchParams({
		id: storageId,
		ct: contentType,
		exp: String(exp),
		sig,
	});
	return `${siteUrl.replace(/\/$/, '')}${SEALED_BLOB_PATH}?${params.toString()}`;
}

/**
 * Re-seal an EXISTING stored blob for the back-fill migration (E8b). Convex
 * storage is immutable per id, so sealing in place means: read the blob, seal
 * its bytes, store the SEALED copy under a NEW id, and return that id (the caller
 * patches the row to point at it, then deletes the old plaintext blob). Returns
 * `null` — no change needed — when there is no key, the blob is missing, or it
 * is ALREADY sealed (so the migration is idempotent and resumable: a re-run
 * re-reads a now-sealed blob and skips it).
 */
export async function resealStoredBlob(
	storage: BlobGet & BlobStore,
	storageId: Id<'_storage'>
): Promise<Id<'_storage'> | null> {
	const secret = getOptional('INSTANCE_SECRET');
	if (secret === undefined) return null;
	const blob = await storage.get(storageId);
	if (!blob) return null;
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const sealed = await sealBytesAtRest(secret, bytes);
	// `sealBytesAtRest` performs the KEYED idempotency check. A structural magic
	// prefix alone is not proof of ciphertext; only bytes that decrypt under this
	// instance key come back unchanged. Compare after that check to avoid storing
	// a duplicate for genuine ciphertext or an empty blob.
	if (sealed.length === bytes.length && sealed.every((byte, index) => byte === bytes[index])) {
		return null;
	}
	return storage.store(
		new Blob([sealed as unknown as BlobPart], {
			type: blob.type || 'application/octet-stream',
		})
	);
}

/** The parsed, VERIFIED fields of a proxy request, or `null` if invalid/expired. */
export interface VerifiedBlobRequest {
	storageId: string;
	contentType: string;
}

/**
 * Verify a proxy request's capability token: the signature must match under
 * `INSTANCE_SECRET` and the expiry must be in the future. Returns the trusted
 * fields on success, `null` on any failure (bad/absent secret, forged or
 * expired token, missing params).
 */
export async function verifyBlobToken(
	id: string | null,
	contentType: string | null,
	exp: string | null,
	sig: string | null
): Promise<VerifiedBlobRequest | null> {
	const secret = getOptional('INSTANCE_SECRET');
	if (secret === undefined || !id || !contentType || !exp || !sig) return null;
	const expMs = Number(exp);
	if (!Number.isFinite(expMs) || expMs < Date.now()) return null;
	const expected = await hmac(secret, tokenMessage(id, contentType, expMs));
	if (!timingSafeStrEqual(expected, sig)) return null;
	return { storageId: id, contentType };
}
