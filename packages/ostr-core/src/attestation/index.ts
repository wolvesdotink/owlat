/**
 * Attestation module: signing and verification over the RFC 8785 canonical
 * form, structural validation of every attestation kind, `_ostr.<domain>` key
 * discovery, and the DKIM-evidence admissibility rules
 * (TRUST_REGISTRY_PLAN §5, §7.1).
 *
 * Everything here is pure and I/O-free: DNS lookups, log submission and clocks
 * belong to the caller, and timestamps are arguments, never `Date.now()`.
 */
export {
	ATTESTATION_SIGNATURE_PREFIX,
	attestationSigningView,
	isAttestationSignature,
	signAttestation,
	verifyAttestationSignature,
} from './sign.js';

export {
	ATTESTATION_KINDS,
	isAttestationKind,
	validateAttestation,
	WINDOW_REQUIRED_KINDS,
	type AttestationValidation,
} from './validate.js';

export {
	BODY_VALIDATORS,
	MAX_BOUNCE_RATE_BUCKET,
	MAX_SCOPE_LENGTH,
	MAX_STATEMENT_LENGTH,
	MAX_UNIQUE_RECIPIENTS_BUCKET,
	normalizeObservedKey,
	type BodyValidator,
} from './bodies.js';

export {
	formatOstrKeyRecord,
	OSTR_KEY_RECORD_PREFIX,
	ostrKeyRecordName,
	parseOstrKeyRecord,
	selectVerifyingKey,
	type OstrKeyRecordParse,
} from './keyRecord.js';

export {
	checkDkimEvidenceAdmissibility,
	MIN_RSA_KEY_BITS,
	REQUIRED_SIGNED_HEADERS,
	type DkimEvidenceAdmissibility,
	type DkimEvidenceInput,
	type DkimInadmissibilityReason,
} from './dkimEvidence.js';

// Only the OSTR-specific predicates are public; the generic JSON helpers stay
// module-internal so the root barrel cannot collide with a sibling module.
export {
	compareRfc3339,
	isChronological,
	isDkimSelector,
	isEd25519Key,
	isFqdn,
	isIpAddress,
	isIpv4,
	isIpv6,
	isRfc3339,
	isSha256Hex,
} from './fields.js';
