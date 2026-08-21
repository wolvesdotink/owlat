/**
 * Module-private crypto/DNS helpers for the DKIM-family signature core
 * (`./messageSignature.ts`). Split out of that file purely for size — nothing
 * here is part of the package's public surface, and none of it makes a verdict
 * decision: it builds the bytes to hash, materializes the published key, and
 * classifies a resolver rejection. The verdict rules stay in one place, next to
 * the RFC comments that justify them.
 */

import { createPublicKey, timingSafeEqual, type KeyObject } from 'crypto';
import { canonicalizeHeaderField, stripSignatureValue, type Canonicalization } from '../canon.js';
import type { DkimVerdict } from '../dmarc.js';
import { isNoRecordDnsError } from '../dnsErrors.js';
import { selectSignedHeaders } from './evidence.js';
import type { DkimKeyRecord } from './keyRecord.js';
import type { HeaderField } from './message.js';

/** DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Build the byte string over which the DKIM signature is computed: the
 * canonicalized signed headers named by `h=` (each selected bottom-up so a
 * later-added duplicate can't be swapped in), followed by the canonicalized
 * DKIM-Signature header itself with its `b=` value emptied and NO trailing CRLF.
 */
export function buildHeaderHashInput(
	headerFields: readonly HeaderField[],
	hTag: string,
	sigField: string,
	mode: Canonicalization
): Buffer {
	// Bottom-up per-name selection lives in `./evidence.ts` so the captured
	// evidence describes exactly these bytes. A name in h= with no (remaining)
	// matching header contributes NOTHING — not even an empty `name:` field or a
	// CRLF — matching mailauth (`getSigningHeaderLines`) / OpenDKIM. This is what
	// lets the standard oversigning defense (`h=from:from`, one From header)
	// verify; a synthetic `${name}:`+CRLF would false-`fail` that legitimate,
	// very common mail.
	const parts = selectSignedHeaders(headerFields, hTag).map((field) =>
		canonicalizeHeaderField(field.raw, mode)
	);

	const sigCanon = canonicalizeHeaderField(stripSignatureValue(sigField), mode);
	const joined = parts.map((p) => `${p}\r\n`).join('') + sigCanon;
	return Buffer.from(joined, 'latin1');
}

/** Construct a Node public key from a parsed DKIM key record. */
export function buildPublicKey(record: DkimKeyRecord, keyType: 'rsa' | 'ed25519'): KeyObject {
	const material = Buffer.from(record.publicKey, 'base64');
	if (keyType === 'ed25519') {
		const der = Buffer.concat([ED25519_SPKI_PREFIX, material]);
		return createPublicKey({ key: der, format: 'der', type: 'spki' });
	}
	// DKIM RSA keys are published as an SPKI SubjectPublicKeyInfo (RFC 6376 §3.6.1),
	// which is also what the mailauth oracle accepts — do NOT fall back to bare
	// PKCS#1, or we would verdict-diverge by accepting a key the oracle rejects.
	return createPublicKey({ key: material, format: 'der', type: 'spki' });
}

/** Classify a resolver rejection into a permanent vs transient DKIM verdict. */
export function classifyDnsError(err: unknown): DkimVerdict {
	return isNoRecordDnsError(err) ? 'permerror' : 'temperror';
}

/**
 * Constant-time equality for base64 hash strings via `crypto.timingSafeEqual`,
 * which needs equal-length buffers (hence the length short-circuit first).
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
	const ab = Buffer.from(a, 'latin1');
	const bb = Buffer.from(b, 'latin1');
	if (ab.length !== bb.length) {
		return false;
	}
	return timingSafeEqual(ab, bb);
}
