/**
 * Evidence bundles (plan §7.2 step 2).
 *
 * When a user reports spam, the observer assembles the proof that the accused
 * domain really sent the message: every header named in the DKIM signature's
 * `h=` list VERBATIM, the `DKIM-Signature` header itself, the DNS key record
 * used at verification, the verdict and the timestamps. The body is never
 * retained — the signature's own `bh=` binds it — and nothing outside `h=` is
 * kept.
 *
 * THE BUNDLE IS LOCAL AND NEVER SUBMITTED. `h=` almost always covers `Subject`
 * and `To`, so a bundle contains exactly the user-level data the public record
 * may never carry; it stays with the observer (encrypted at rest, ~90 day
 * retention). What reaches a log is {@link buildSpamReportBatch}'s count plus a
 * Merkle commitment over {@link EvidenceBundleResult.bundleHash} values, and
 * bundles themselves are revealed only to adjudicating monitors, sampled, on
 * challenge (§7.2.4). Redacting a signed header — hashing the Subject, say —
 * would make the signature unverifiable, which is why the privacy line is drawn
 * at who sees a bundle, never at what is inside one.
 *
 * Admissibility is checked FIRST, by `@owlat/ostr-core`: an `l=` signature, a
 * sub-2048-bit RSA key or a signature not covering From/Date/Message-ID is not
 * evidence, and no amount of correct capture makes it evidence (§7.1).
 */
import {
	canonicalBytes,
	checkDkimEvidenceAdmissibility,
	isDkimSelector,
	isRfc3339,
	sha256,
	type DkimInadmissibilityReason,
} from '@owlat/ostr-core';
import { normalizeDomain } from './types.js';

/** One retained header, exactly as it appeared on the wire. */
export interface RawSignedHeader {
	/** Header field name as received (case preserved). */
	name: string;
	/** The full field, verbatim: name, colon, value, original folding — the
	 *  bytes a re-verification hashes. */
	raw: string;
}

/** What a DKIM verifier concluded. Only `pass` can back a report. */
export type DkimVerificationVerdict = 'pass' | 'fail' | 'neutral' | 'temperror' | 'permerror';

/**
 * Everything the inbound verdict path holds about one verified signature at
 * the moment a user reports the message. Fields below `signedHeaderNames` are
 * the `@owlat/ostr-core` admissibility inputs, passed through unchanged.
 */
export interface EvidenceInput {
	/** Every header named in `h=`, verbatim, in the order the verifier consumed
	 *  them. Headers not named in `h=` must not be here — they are unsigned and
	 *  retaining them is user data the bundle has no use for. */
	rawSignedHeaders: readonly RawSignedHeader[];
	/** The `DKIM-Signature` field itself, verbatim. */
	dkimSignatureHeader: string;
	/** The `<selector>._domainkey.<domain>` TXT record used at verification. */
	dnsKeyRecordTxt: string;
	verificationVerdict: DkimVerificationVerdict;
	/** RFC 3339 UTC instant the signature was verified. */
	verifiedAt: string;
	/** The message's `Message-ID`, value only — the dedupe half of §7.3. */
	messageId: string;
	/** The signature's `bh=` value, verbatim base64. */
	bodyHash: string;
	/** The signature's `d=`. */
	signingDomain: string;
	/** The signature's `s=`. */
	selector: string;
	/** The signature's `a=`, e.g. `rsa-sha256`. */
	algorithm: string;
	/** Signing key size in bits; required for RSA. */
	keyBits?: number;
	/** Whether the signature carried an `l=` body-length tag. Only an explicit
	 *  `false` counts as absent (see `checkDkimEvidenceAdmissibility`). */
	usesBodyLengthTag: boolean;
	/** The `h=` list, in signature order. */
	signedHeaderNames: readonly string[];
}

/**
 * Capture-side refusals, distinct from the `@owlat/ostr-core` admissibility
 * reasons they are unioned with. These say the observer failed to retain a
 * usable bundle; a monitor never sees them, but an operator must.
 */
export type EvidenceCaptureReason =
	| 'verification-not-pass'
	| 'missing-signed-header-bytes'
	| 'unsigned-header-retained'
	| 'missing-dkim-signature-header'
	| 'missing-dns-key-record'
	| 'invalid-message-id'
	| 'invalid-body-hash'
	| 'invalid-signing-domain'
	| 'invalid-selector'
	| 'invalid-verified-at';

export type EvidenceRejectionReason = DkimInadmissibilityReason | EvidenceCaptureReason;

/**
 * The retained bundle. Deliberately flat and free of optional decoration: it is
 * hashed into a commitment that must still verify years later, so every field
 * an observer could vary is one a monitor would have to be told about.
 */
export interface EvidenceBundle {
	v: 1;
	messageId: string;
	bodyHash: string;
	/** The `d=`, folded — pass it to `buildSpamReportBatch` alongside the hash so
	 *  the batch can refuse evidence that does not name the accused. */
	signingDomain: string;
	selector: string;
	algorithm: string;
	/** Present only for RSA, where it is what clears the strength floor. */
	keyBits?: number;
	verifiedAt: string;
	verificationVerdict: 'pass';
	/** The `h=` list, lowercased, in signature order. */
	signedHeaderNames: string[];
	/** The retained headers, verbatim. */
	signedHeaders: RawSignedHeader[];
	dkimSignatureHeader: string;
	dnsKeyRecordTxt: string;
}

export type EvidenceBundleResult =
	| { ok: true; bundle: EvidenceBundle; bundleHash: string }
	| { ok: false; reasons: EvidenceRejectionReason[] };

/** Headers that must be retained verbatim; admissibility already requires the
 *  signature to cover them, so their absence from the capture is the observer's
 *  bug, not the sender's. */
const REQUIRED_RETAINED_HEADERS = ['from', 'date', 'message-id'] as const;

function headerName(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim().toLowerCase();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * `h=` can name a header that does not exist (oversigning: `h=from:from` proves
 * a second `From` was absent), so the capture is checked for coverage of the
 * headers that must exist, and for the absence of anything `h=` did not name.
 */
function checkRetainedHeaders(input: EvidenceInput, reasons: EvidenceRejectionReason[]): void {
	const raw = Array.isArray(input.rawSignedHeaders) ? input.rawSignedHeaders : [];
	const signed = new Set<string>();
	for (const name of input.signedHeaderNames) {
		const normalized = headerName(name);
		if (normalized !== null) signed.add(normalized);
	}
	const retained = new Set<string>();
	let extraneous = false;
	let malformed = false;
	for (const header of raw) {
		const name = headerName(header?.name);
		if (name === null || typeof header.raw !== 'string' || header.raw.length === 0) {
			malformed = true;
			continue;
		}
		if (!signed.has(name)) extraneous = true;
		retained.add(name);
	}
	if (malformed || REQUIRED_RETAINED_HEADERS.some((name) => !retained.has(name))) {
		reasons.push('missing-signed-header-bytes');
	}
	if (extraneous) reasons.push('unsigned-header-retained');
}

function checkArtifacts(
	input: EvidenceInput,
	signingDomain: string | undefined,
	reasons: EvidenceRejectionReason[]
): void {
	if (typeof input.dkimSignatureHeader !== 'string' || input.dkimSignatureHeader.trim() === '') {
		reasons.push('missing-dkim-signature-header');
	}
	if (typeof input.dnsKeyRecordTxt !== 'string' || input.dnsKeyRecordTxt.trim() === '') {
		reasons.push('missing-dns-key-record');
	}
	if (typeof input.messageId !== 'string' || input.messageId.trim() === '') {
		reasons.push('invalid-message-id');
	}
	// `bh=` is base64 of a digest; its exact bytes are part of the dedupe key,
	// so only obvious junk is refused here rather than re-derived.
	if (typeof input.bodyHash !== 'string' || input.bodyHash.trim() === '') {
		reasons.push('invalid-body-hash');
	}
	if (signingDomain === undefined) reasons.push('invalid-signing-domain');
	if (!isDkimSelector(input.selector)) reasons.push('invalid-selector');
	if (!isRfc3339(input.verifiedAt)) reasons.push('invalid-verified-at');
}

/**
 * Assemble and hash one evidence bundle.
 *
 * The `@owlat/ostr-core` admissibility rules run first and short-circuit: a
 * signature that is not evidence produces no bundle, and the reasons come back
 * in the core's fixed order so two observers refusing the same signature say
 * the same thing. Capture-completeness checks run only for signatures that
 * cleared that gate.
 *
 * `bundleHash` is the lowercase hex SHA-256 of the RFC 8785 (JCS) canonical
 * form of `bundle` — the leaf {@link buildSpamReportBatch} commits to, and the
 * value a monitor recomputes from a revealed bundle at challenge time. It is
 * stable across key order, so a store that reserializes a bundle cannot silently
 * invalidate the commitment.
 */
export function buildEvidenceBundle(input: EvidenceInput): EvidenceBundleResult {
	const admissibility = checkDkimEvidenceAdmissibility({
		algorithm: input.algorithm,
		keyBits: input.keyBits,
		usesBodyLengthTag: input.usesBodyLengthTag,
		signedHeaderNames: [...input.signedHeaderNames],
	});
	if (!admissibility.admissible) return { ok: false, reasons: [...admissibility.reasons] };

	// Folded once, here: the validation below and the bundle built from it must
	// be the same rule, and a second call is a second rule waiting to drift.
	const signingDomain = normalizeDomain(input.signingDomain);
	const reasons: EvidenceRejectionReason[] = [];
	if (input.verificationVerdict !== 'pass') reasons.push('verification-not-pass');
	checkRetainedHeaders(input, reasons);
	checkArtifacts(input, signingDomain, reasons);
	if (reasons.length > 0) return { ok: false, reasons };
	// `checkArtifacts` refuses an unusable signing domain, so an empty reason
	// list means this is a string; the guard is how the compiler learns that.
	if (signingDomain === undefined) return { ok: false, reasons: ['invalid-signing-domain'] };

	const bundle: EvidenceBundle = {
		v: 1,
		messageId: input.messageId,
		bodyHash: input.bodyHash,
		signingDomain,
		selector: input.selector,
		algorithm: input.algorithm.trim().toLowerCase(),
		verifiedAt: input.verifiedAt,
		verificationVerdict: 'pass',
		signedHeaderNames: input.signedHeaderNames
			.map((name) => headerName(name))
			.filter((name): name is string => name !== null),
		signedHeaders: input.rawSignedHeaders.map((header) => ({
			name: header.name,
			raw: header.raw,
		})),
		dkimSignatureHeader: input.dkimSignatureHeader,
		dnsKeyRecordTxt: input.dnsKeyRecordTxt,
	};
	if (typeof input.keyBits === 'number') bundle.keyBits = input.keyBits;

	return { ok: true, bundle, bundleHash: sha256(canonicalBytes(bundle)).toString('hex') };
}

/** Recompute a retained bundle's hash — the check a monitor runs on an opened
 *  bundle before testing its Merkle proof. */
export function hashEvidenceBundle(bundle: EvidenceBundle): string {
	return sha256(canonicalBytes(bundle)).toString('hex');
}
