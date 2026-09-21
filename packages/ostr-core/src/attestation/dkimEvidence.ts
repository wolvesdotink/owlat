/**
 * Admissibility of a DKIM signature AS EVIDENCE (plan §7.1).
 *
 * These are registry rules, not DKIM verification: the caller has already
 * verified the signature and passes in what it verified. DKIM was designed for
 * transit-time authentication, so several signatures that a verifier calls
 * `pass` prove nothing durable about what a domain actually sent — those are
 * rejected here, before the evidence can move a score.
 *
 * A rejected signature is not an accusation against the sender; it only means
 * a spam report resting on it carries no weight (plan §7.3).
 */

/** Stable identifiers — they are quoted in audit findings and appeals, so they
 *  are part of the wire contract, not display strings. */
export type DkimInadmissibilityReason =
	| 'body-length-tag'
	| 'unsupported-algorithm'
	| 'weak-hash'
	| 'unknown-rsa-key-size'
	| 'weak-rsa-key'
	| 'unsigned-from'
	| 'unsigned-date'
	| 'unsigned-message-id';

export interface DkimEvidenceInput {
	/** DKIM `a=` value, e.g. `rsa-sha256`, `ed25519-sha256`. */
	algorithm: string;
	/** Signing key size in bits; required for RSA, ignored for ed25519. */
	keyBits?: number;
	/** Whether the signature carried an `l=` body-length tag. Only an explicit
	 *  `false` counts as absent: a parser that yields `0`, `''` or `undefined`
	 *  has not established that the tag was missing. */
	usesBodyLengthTag: boolean;
	/** The `h=` list, in any case and any order. */
	signedHeaderNames: string[];
}

export interface DkimEvidenceAdmissibility {
	admissible: boolean;
	reasons: DkimInadmissibilityReason[];
}

/** The current RSA strength floor (plan §7.1). */
export const MIN_RSA_KEY_BITS = 2048;

/**
 * Headers a signature must cover for the evidence to identify a message: who
 * sent it, when, and which message it was. Without them a valid signature
 * proves only that the domain signed *something*.
 */
export const REQUIRED_SIGNED_HEADERS = ['from', 'date', 'message-id'] as const;

const MISSING_HEADER_REASON: Record<
	(typeof REQUIRED_SIGNED_HEADERS)[number],
	DkimInadmissibilityReason
> = {
	from: 'unsigned-from',
	date: 'unsigned-date',
	'message-id': 'unsigned-message-id',
};

/**
 * Decide whether a verified DKIM signature is admissible evidence.
 *
 * Reasons accumulate in a fixed order so two verifiers of the same signature
 * produce byte-identical output. An empty reason list is the only admissible
 * result.
 */
export function checkDkimEvidenceAdmissibility(
	input: DkimEvidenceInput
): DkimEvidenceAdmissibility {
	const reasons: DkimInadmissibilityReason[] = [];

	// `l=` bounds how much of the body is signed, so content can be appended to
	// a signed message and still verify: the message shown may be half unsigned.
	// Fail closed — every other input here is re-checked at runtime too, and an
	// unproven absence must not be the one that admits evidence.
	if (input.usesBodyLengthTag !== false) reasons.push('body-length-tag');

	const algorithm = typeof input.algorithm === 'string' ? input.algorithm.trim().toLowerCase() : '';
	const parts = algorithm.split('-');
	const keyType = parts.length === 2 ? parts[0] : undefined;
	const hash = parts[1];
	if (keyType !== 'rsa' && keyType !== 'ed25519') {
		reasons.push('unsupported-algorithm');
	} else if (hash !== 'sha256') {
		// sha1 is a collision-broken binding between signature and message; the
		// strength floor applies to the digest as much as to the key.
		reasons.push('weak-hash');
	}

	if (keyType === 'rsa') {
		const keyBits = input.keyBits;
		if (typeof keyBits !== 'number' || !Number.isSafeInteger(keyBits) || keyBits <= 0) {
			// An unproven key size cannot clear the floor.
			reasons.push('unknown-rsa-key-size');
		} else if (keyBits < MIN_RSA_KEY_BITS) {
			reasons.push('weak-rsa-key');
		}
	}

	const signed = new Set(
		(Array.isArray(input.signedHeaderNames) ? input.signedHeaderNames : [])
			.filter((name): name is string => typeof name === 'string')
			.map((name) => name.trim().toLowerCase())
	);
	for (const header of REQUIRED_SIGNED_HEADERS) {
		if (!signed.has(header)) reasons.push(MISSING_HEADER_REASON[header]);
	}

	return { admissible: reasons.length === 0, reasons };
}
