/**
 * Signing envelope shared by this module's signed documents — signed tree heads
 * and inclusion promises (plan §9.1).
 *
 * Every OSTR signature is computed the same way: ed25519 over the RFC 8785
 * canonical JSON of the payload, base64, behind an algorithm prefix. The
 * payload always carries `v` and `type`, so a signature over one document kind
 * can never be replayed as another — RFC 9162 §4.10 carries `version` and
 * `signature_type` for exactly that reason; the encoding differs here (JCS, not
 * TLS), the domain separation does not.
 *
 * Internal to the merkle module: the barrel exports the documents, not the
 * plumbing.
 */

import { isBase64OfLength, isRfc3339 } from '../attestation/fields.js';
import { ATTESTATION_SIGNATURE_PREFIX } from '../attestation/sign.js';
import { ed25519Sign, ed25519Verify } from '../crypto.js';
import { canonicalBytes } from '../jcs.js';

/** The one signature algorithm `v: 1` defines, declared once in `attestation/sign.ts`. */
export const SIGNATURE_PREFIX = ATTESTATION_SIGNATURE_PREFIX;

/** Version carried by every signed document of this module. */
export const SIGNED_DOCUMENT_VERSION = 1;

const ED25519_SIGNATURE_BYTES = 64;

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * RFC 3339 instant narrowed to uppercase `T` and a `Z` designator. Gossiped
 * documents are compared byte-for-byte, so one instant gets one spelling;
 * calendar validity (`2026-02-30`, `10:30:60`) comes from the package's shared
 * `isRfc3339`, which this only restricts.
 */
export function isUtcInstant(value: unknown): value is string {
	return typeof value === 'string' && UTC_INSTANT.test(value) && isRfc3339(value);
}

/** `ed25519:<base64>` over the canonical JSON of `payload`. */
export function signPayload(payload: Record<string, unknown>, privateKeyBase64: string): string {
	return SIGNATURE_PREFIX + ed25519Sign(canonicalBytes(payload), privateKeyBase64);
}

/**
 * Verify `sig` over `payload`. Total: a foreign algorithm prefix, a malformed
 * key and a malformed signature all answer `false`.
 *
 * The signature must be canonical base64 of exactly 64 bytes. Without that
 * check the unpadded, whitespace-injected, base64url and trailing-garbage
 * spellings of one signature all verify, which would give a log several
 * byte-distinct documents with the same meaning — and STH gossip dedups by
 * content.
 */
export function verifyPayload(
	payload: Record<string, unknown>,
	sig: unknown,
	publicKeyBase64: string
): boolean {
	if (typeof sig !== 'string' || !sig.startsWith(SIGNATURE_PREFIX)) return false;
	const signature = sig.slice(SIGNATURE_PREFIX.length);
	if (!isBase64OfLength(signature, ED25519_SIGNATURE_BYTES)) return false;
	return ed25519Verify(canonicalBytes(payload), signature, publicKeyBase64);
}
