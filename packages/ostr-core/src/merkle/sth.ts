/**
 * Signed Tree Heads — the log's periodically published, signed commitment to
 * its history (plan §9.1).
 *
 * This is RFC 9162 §4.10's TreeHeadSignature over the same facts (a version, a
 * signature-type tag, the timestamp, the tree size and the root hash) in a
 * different encoding: RFC 8785 canonical JSON rather than TLS, so every OSTR
 * signature — attestation, STH, inclusion promise — is computed the same way.
 * The `v`/`type` pair is what stops an STH signature from being replayed as
 * another signed document. The RFC's `log_id` (a key hash) is carried as the
 * string `logId`, because OSTR logs are named by URL.
 *
 * An STH is the only thing a verifier has to trust, and only as far as the
 * log's key goes: inclusion and consistency proofs are checked *against* it.
 * The equivocation check over a pair of heads lives in `./equivocation.js`.
 *
 * `timestamp` is an argument, never a clock read: signing must be
 * reproducible, and a monitor replaying the log has to get byte-identical
 * signing input.
 */

import { isRecord, isSha256Hex } from '../attestation/fields.js';
import { canonicalBytes } from '../jcs.js';
import { isUtcInstant, SIGNED_DOCUMENT_VERSION, signPayload, verifyPayload } from './signing.js';

/** Signature-type tag of an STH payload (RFC 9162's `signature_type`). */
export const STH_SIGNATURE_TYPE = 'sth';

/** The head's facts, without the version, the type tag or the signature. */
export interface UnsignedTreeHead {
	/** Stable identifier of the issuing log, e.g. its base URL or key hash. */
	logId: string;
	/** Number of leaves the head commits to. */
	treeSize: number;
	/** MTH of the first `treeSize` leaves, lowercase hex SHA-256. */
	rootHash: string;
	/**
	 * RFC 3339 UTC instant the head was issued — supplied by the caller, and
	 * required to end in `Z`: heads are gossiped and compared byte-for-byte, so
	 * one instant gets exactly one spelling.
	 */
	timestamp: string;
}

export interface SignedTreeHead extends UnsignedTreeHead {
	v: typeof SIGNED_DOCUMENT_VERSION;
	type: typeof STH_SIGNATURE_TYPE;
	/** `ed25519:<base64>` over {@link treeHeadSigningBytes}. */
	sig: string;
}

function isWellFormed(head: UnsignedTreeHead): boolean {
	return (
		typeof head.logId === 'string' &&
		head.logId.length > 0 &&
		Number.isSafeInteger(head.treeSize) &&
		head.treeSize >= 0 &&
		isSha256Hex(head.rootHash) &&
		isUtcInstant(head.timestamp)
	);
}

/** The signed payload: the head's facts plus the version and type tag. */
function signedPayload(head: UnsignedTreeHead): Record<string, unknown> {
	const { logId, rootHash, timestamp, treeSize } = head;
	return {
		logId,
		rootHash,
		timestamp,
		treeSize,
		type: STH_SIGNATURE_TYPE,
		v: SIGNED_DOCUMENT_VERSION,
	};
}

/**
 * The exact bytes an STH signature covers: the RFC 8785 canonical JSON of
 * `{logId, rootHash, timestamp, treeSize, type, v}`. Named explicitly (rather
 * than "the STH minus `sig`") so an independent implementation can reproduce
 * them without guessing which fields count.
 *
 * @throws RangeError for a malformed head — the same admission rule
 * {@link signTreeHead} enforces, so the two exported entry points cannot
 * disagree about which heads are signable.
 */
export function treeHeadSigningBytes(head: UnsignedTreeHead): Buffer {
	if (!isWellFormed(head)) {
		throw new RangeError(
			'tree head must have a logId, a hex sha256 rootHash, a non-negative integer treeSize and an RFC 3339 UTC timestamp ending in Z'
		);
	}
	return canonicalBytes(signedPayload(head));
}

/**
 * Sign a tree head with the log's raw base64 ed25519 private key.
 *
 * @throws RangeError if the head is malformed — an unsigned-but-invalid STH
 * would be rejected by every verifier anyway, so it fails loudly at the source.
 */
export function signTreeHead(head: UnsignedTreeHead, privateKeyBase64: string): SignedTreeHead {
	// Admission check; the payload below is the same one it validates.
	treeHeadSigningBytes(head);
	const { logId, rootHash, timestamp, treeSize } = head;
	return {
		v: SIGNED_DOCUMENT_VERSION,
		type: STH_SIGNATURE_TYPE,
		logId,
		treeSize,
		rootHash,
		timestamp,
		sig: signPayload(signedPayload(head), privateKeyBase64),
	};
}

/**
 * Verify an STH against the log's raw base64 ed25519 public key. Malformed
 * heads, a wrong version or type tag, foreign signature algorithms,
 * non-canonical signature encodings and bad keys all return `false`; this never
 * throws, because STHs arrive from untrusted logs and gossip peers.
 */
export function verifyTreeHead(sth: SignedTreeHead, publicKeyBase64: string): boolean {
	if (!isRecord(sth)) return false;
	if (sth.v !== SIGNED_DOCUMENT_VERSION || sth.type !== STH_SIGNATURE_TYPE) return false;
	if (!isWellFormed(sth)) return false;
	return verifyPayload(signedPayload(sth), sth.sig, publicKeyBase64);
}
