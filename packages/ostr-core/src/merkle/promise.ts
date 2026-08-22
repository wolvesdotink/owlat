/**
 * Inclusion promises — the SCT-equivalent of plan §9.1: on accepting a
 * submission the log signs a promise to merge it into the tree within its
 * maximum merge delay (MMD, e.g. 24h), before any STH covers it.
 *
 * The promise is what makes cross-submission to several logs useful: a
 * submitter holds a signed, attributable commitment from each log immediately,
 * and a log that never produces the corresponding inclusion proof before the
 * deadline has published evidence against itself.
 *
 * A promise binds a *leaf*, not an attestation: the log commits to the exact
 * bytes it was handed, `SHA-256(0x00 || leaf)` in the log's own tree. Use
 * {@link inclusionPromiseCoversLeaf} rather than comparing hex by hand.
 *
 * Deadlines are derived, never read from a clock — {@link inclusionDeadline}
 * returns an instant for the caller to compare against a `now` it supplies.
 */

import { isRecord, isSha256Hex } from '../attestation/fields.js';
import { canonicalBytes } from '../jcs.js';
import { leafHash } from './hash.js';
import { toHex } from './hex.js';
import { isUtcInstant, SIGNED_DOCUMENT_VERSION, signPayload, verifyPayload } from './signing.js';

/** Signature-type tag of an inclusion-promise payload. */
export const INCLUSION_PROMISE_TYPE = 'inclusion-promise';

/** The promise's facts, without the version, the type tag or the signature. */
export interface UnsignedInclusionPromise {
	/** Stable identifier of the promising log. */
	logId: string;
	/** `SHA-256(0x00 || leaf)` of the accepted submission, lowercase hex. */
	leafHash: string;
	/** RFC 3339 UTC instant of acceptance, ending in `Z` — the caller's clock. */
	timestamp: string;
	/** Maximum merge delay in seconds; inclusion is due at `timestamp + mmd`. */
	mmdSeconds: number;
}

export interface SignedInclusionPromise extends UnsignedInclusionPromise {
	v: typeof SIGNED_DOCUMENT_VERSION;
	type: typeof INCLUSION_PROMISE_TYPE;
	/** `ed25519:<base64>` over {@link inclusionPromiseSigningBytes}. */
	sig: string;
}

function isWellFormed(promise: UnsignedInclusionPromise): boolean {
	return (
		typeof promise.logId === 'string' &&
		promise.logId.length > 0 &&
		isSha256Hex(promise.leafHash) &&
		isUtcInstant(promise.timestamp) &&
		Number.isSafeInteger(promise.mmdSeconds) &&
		promise.mmdSeconds > 0
	);
}

function signedPayload(promise: UnsignedInclusionPromise): Record<string, unknown> {
	const { logId, leafHash: leaf, mmdSeconds, timestamp } = promise;
	return {
		leafHash: leaf,
		logId,
		mmdSeconds,
		timestamp,
		type: INCLUSION_PROMISE_TYPE,
		v: SIGNED_DOCUMENT_VERSION,
	};
}

/**
 * The exact bytes an inclusion-promise signature covers: the RFC 8785
 * canonical JSON of `{leafHash, logId, mmdSeconds, timestamp, type, v}`.
 *
 * @throws RangeError for a malformed promise — the same admission rule
 * {@link signInclusionPromise} enforces.
 */
export function inclusionPromiseSigningBytes(promise: UnsignedInclusionPromise): Buffer {
	if (!isWellFormed(promise)) {
		throw new RangeError(
			'inclusion promise must have a logId, a hex sha256 leafHash, a positive integer mmdSeconds and an RFC 3339 UTC timestamp ending in Z'
		);
	}
	return canonicalBytes(signedPayload(promise));
}

/**
 * Sign a promise with the log's raw base64 ed25519 private key.
 *
 * @throws RangeError if the promise is malformed.
 */
export function signInclusionPromise(
	promise: UnsignedInclusionPromise,
	privateKeyBase64: string
): SignedInclusionPromise {
	inclusionPromiseSigningBytes(promise);
	const { logId, leafHash: leaf, mmdSeconds, timestamp } = promise;
	return {
		v: SIGNED_DOCUMENT_VERSION,
		type: INCLUSION_PROMISE_TYPE,
		logId,
		leafHash: leaf,
		timestamp,
		mmdSeconds,
		sig: signPayload(signedPayload(promise), privateKeyBase64),
	};
}

/**
 * Verify a promise against the log's raw base64 ed25519 public key. Total: a
 * wrong version or type tag, a malformed field, a foreign algorithm and a
 * non-canonical signature encoding all answer `false`.
 */
export function verifyInclusionPromise(
	promise: SignedInclusionPromise,
	publicKeyBase64: string
): boolean {
	if (!isRecord(promise)) return false;
	if (promise.v !== SIGNED_DOCUMENT_VERSION || promise.type !== INCLUSION_PROMISE_TYPE) {
		return false;
	}
	if (!isWellFormed(promise)) return false;
	return verifyPayload(signedPayload(promise), promise.sig, publicKeyBase64);
}

/**
 * True when the promise covers exactly these leaf bytes. Verify the signature
 * first — this only checks the binding, not the promise's authenticity.
 */
export function inclusionPromiseCoversLeaf(
	promise: UnsignedInclusionPromise,
	leaf: Uint8Array
): boolean {
	return isSha256Hex(promise.leafHash) && promise.leafHash === toHex(leafHash(leaf));
}

/**
 * Instant the log owes an inclusion proof by, as epoch milliseconds — compare
 * against a `now` the caller supplies. `undefined` for a malformed promise.
 */
export function inclusionDeadline(promise: UnsignedInclusionPromise): number | undefined {
	if (!isWellFormed(promise)) return undefined;
	return Date.parse(promise.timestamp) + promise.mmdSeconds * 1000;
}
