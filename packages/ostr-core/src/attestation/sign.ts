/**
 * Attestation signing and signature verification.
 *
 * The signature covers the RFC 8785 canonical form of the document with `sig`
 * removed and nothing else — no header, no context string. Every field present
 * on the document is therefore signed, including ones this version does not
 * know about, so a later extension field cannot be added or stripped in
 * transit without breaking the signature.
 */
import { canonicalBytes } from '../jcs.js';
import { ed25519Sign, ed25519Verify } from '../crypto.js';
import type { Attestation, UnsignedAttestation } from '../types.js';
import { isBase64OfLength, isEd25519Key, isRecord } from './fields.js';

/** The only signature algorithm `v: 1` defines. */
export const ATTESTATION_SIGNATURE_PREFIX = 'ed25519:';

const ED25519_SIGNATURE_BYTES = 64;

/**
 * `ed25519:<canonical base64 of 64 bytes>` — the only signature form `v: 1`
 * defines. Declared once so the shape {@link validateAttestation} accepts and
 * the shape this module can verify cannot drift apart.
 */
export function isAttestationSignature(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.startsWith(ATTESTATION_SIGNATURE_PREFIX) &&
		isBase64OfLength(value.slice(ATTESTATION_SIGNATURE_PREFIX.length), ED25519_SIGNATURE_BYTES)
	);
}

/**
 * The document a signature is computed over: every own field except `sig`.
 * Signer and verifier both go through here, so the two can never disagree
 * about what was covered.
 *
 * The view has a null prototype. A plain object literal would route an own
 * `__proto__` member of the source through the inherited setter, leaving it out
 * of the canonical bytes — an unsigned envelope field that could be added,
 * changed or stripped without breaking the signature.
 */
export function attestationSigningView<TBody>(
	doc: UnsignedAttestation<TBody> | Attestation<TBody>
): Record<string, unknown> {
	const source = doc as unknown as Record<string, unknown>;
	const view = Object.create(null) as Record<string, unknown>;
	for (const key of Object.keys(source)) {
		if (key === 'sig') continue;
		view[key] = source[key];
	}
	return view;
}

/**
 * Sign `unsigned` with a raw base64 ed25519 private key, returning the
 * attestation with its `sig` attached.
 *
 * Throws if the key is not 32 raw bytes or the document contains values JCS
 * cannot serialize (non-finite numbers, functions). Structural validity is not
 * checked — call {@link validateAttestation} before submitting to a log.
 */
export function signAttestation<TBody>(
	unsigned: UnsignedAttestation<TBody>,
	privateKeyBase64: string
): Attestation<TBody> {
	const signature = ed25519Sign(canonicalBytes(attestationSigningView(unsigned)), privateKeyBase64);
	return { ...unsigned, sig: `${ATTESTATION_SIGNATURE_PREFIX}${signature}` };
}

/**
 * Verify `att` against a raw base64 ed25519 public key.
 *
 * Only `v: 1` documents verify. The rule implemented here — ed25519 over the
 * canonical form minus `sig` — is the `v: 1` rule, and the `ed25519:` label
 * sits outside the signed bytes, so `v` is the only field binding a document to
 * its signing scheme; a later version must not be checked under this one.
 *
 * Total: malformed documents, malformed signatures and malformed keys all
 * answer `false`. A caller distinguishing "wrong key" from "corrupt record"
 * runs {@link validateAttestation} first.
 */
export function verifyAttestationSignature(att: Attestation, publicKeyBase64: string): boolean {
	if (!isRecord(att) || att['v'] !== 1 || !isEd25519Key(publicKeyBase64)) return false;
	const sig = att['sig'];
	if (!isAttestationSignature(sig)) return false;
	const signature = sig.slice(ATTESTATION_SIGNATURE_PREFIX.length);
	let signed: Buffer;
	try {
		signed = canonicalBytes(attestationSigningView(att));
	} catch {
		return false;
	}
	return ed25519Verify(signed, signature, publicKeyBase64);
}
