/**
 * DANE / TLSA (RFC 6698, RFC 7671, RFC 7672) — the ONE parse/match implementation.
 *
 * A TLSA record is a certificate association published in DNS as
 * `<usage> <selector> <matching-type> <association-data-hex>`. This module is the
 * single source of truth for parsing that wire form and for deciding whether a
 * presented certificate (chain) is authenticated by a published TLSA RRset, so
 * both callers converge on identical semantics:
 *
 *  - the own-domain DNS verifier in `apps/api/convex/domains/dnsVerification.ts`
 *    (does the operator's published TLSA record match what DNS returns?), and
 *  - the outbound sender's DANE-at-send path in `apps/mta` (does the recipient
 *    MX's certificate match the recipient's published TLSA RRset? — RFC 7672).
 *
 * PURE: no Convex, no network, no MTA imports. Certificate bytes are DER; hashing
 * uses `node:crypto`, which is available in both the Convex Node action runtime
 * and the MTA.
 *
 * SMTP scope (RFC 7672 §2.1): only certificate usages DANE-TA(2) and DANE-EE(3)
 * are usable for SMTP. Usages PKIX-TA(0)/PKIX-EE(1) are treated as unusable, so a
 * TLSA RRset containing only 0/1 records yields "no usable DANE" and the caller
 * falls back to its non-DANE policy (opportunistic / MTA-STS).
 */

import { createHash, X509Certificate } from 'node:crypto';

/** DANE certificate usage (RFC 6698 §2.1.1). */
export const DANE_USAGE = {
	PKIX_TA: 0,
	PKIX_EE: 1,
	DANE_TA: 2,
	DANE_EE: 3,
} as const;

/** DANE selector (RFC 6698 §2.1.2): full certificate vs SubjectPublicKeyInfo. */
export const DANE_SELECTOR = {
	FULL_CERT: 0,
	SPKI: 1,
} as const;

/** DANE matching type (RFC 6698 §2.1.3): exact / SHA-256 / SHA-512. */
export const DANE_MATCHING = {
	EXACT: 0,
	SHA256: 1,
	SHA512: 2,
} as const;

/** A parsed TLSA certificate association. */
export interface TlsaRecord {
	usage: number;
	selector: number;
	matchingType: number;
	/** Association data as lowercase hex (no whitespace). */
	data: string;
}

/**
 * Parse a TLSA record from its presentation form
 * `"<usage> <selector> <matching-type> <hex>"` (RFC 6698 §2.2). The association
 * data may be split across whitespace (DNS presentation allows it) and is
 * normalised to contiguous lowercase hex. Returns `null` for anything that is
 * not a well-formed TLSA payload (too few fields, non-integer parameters,
 * empty/non-hex data).
 */
export function parseTlsaRecord(raw: string): TlsaRecord | null {
	const parts = raw.trim().split(/\s+/);
	if (parts.length < 4) return null;

	const usage = Number(parts[0]);
	const selector = Number(parts[1]);
	const matchingType = Number(parts[2]);
	if (!Number.isInteger(usage) || !Number.isInteger(selector) || !Number.isInteger(matchingType)) {
		return null;
	}

	const data = parts.slice(3).join('').toLowerCase();
	if (data.length === 0 || data.length % 2 !== 0 || !/^[0-9a-f]+$/.test(data)) {
		return null;
	}

	return { usage, selector, matchingType, data };
}

/** True when two parsed TLSA associations are byte-for-byte identical. */
export function tlsaRecordsEqual(a: TlsaRecord, b: TlsaRecord): boolean {
	return (
		a.usage === b.usage &&
		a.selector === b.selector &&
		a.matchingType === b.matchingType &&
		a.data === b.data
	);
}

/**
 * Whether a TLSA record is usable for SMTP DANE (RFC 7672 §2.1): usage DANE-TA(2)
 * or DANE-EE(3), a known selector (0/1) and a known matching type (0/1/2).
 */
export function isUsableForSmtp(record: TlsaRecord): boolean {
	const usableUsage = record.usage === DANE_USAGE.DANE_TA || record.usage === DANE_USAGE.DANE_EE;
	const knownSelector =
		record.selector === DANE_SELECTOR.FULL_CERT || record.selector === DANE_SELECTOR.SPKI;
	const knownMatching =
		record.matchingType === DANE_MATCHING.EXACT ||
		record.matchingType === DANE_MATCHING.SHA256 ||
		record.matchingType === DANE_MATCHING.SHA512;
	return usableUsage && knownSelector && knownMatching;
}

/** Whether a TLSA RRset contains at least one SMTP-usable record. */
export function hasUsableTlsa(records: readonly TlsaRecord[]): boolean {
	return records.some(isUsableForSmtp);
}

/**
 * Select the bytes a TLSA record's selector points at: the full certificate DER
 * (selector 0) or its SubjectPublicKeyInfo DER (selector 1). Returns `null` for
 * an unknown selector or an unparseable certificate.
 */
function selectData(certDer: Buffer, selector: number): Buffer | null {
	if (selector === DANE_SELECTOR.FULL_CERT) return certDer;
	if (selector === DANE_SELECTOR.SPKI) {
		try {
			return new X509Certificate(certDer).publicKey.export({
				type: 'spki',
				format: 'der',
			}) as Buffer;
		} catch {
			return null;
		}
	}
	return null;
}

/** Apply a TLSA matching type to selected bytes, returning lowercase hex. */
function applyMatching(data: Buffer, matchingType: number): string | null {
	switch (matchingType) {
		case DANE_MATCHING.EXACT:
			return data.toString('hex').toLowerCase();
		case DANE_MATCHING.SHA256:
			return createHash('sha256').update(data).digest('hex');
		case DANE_MATCHING.SHA512:
			return createHash('sha512').update(data).digest('hex');
		default:
			return null;
	}
}

/**
 * Compute the TLSA association data (lowercase hex) for a certificate under a
 * given selector + matching type (RFC 6698 §2.1). Returns `null` when the
 * selector/matching type is unknown or the certificate cannot be parsed.
 */
export function computeAssociation(
	certDer: Buffer,
	selector: number,
	matchingType: number
): string | null {
	const selected = selectData(certDer, selector);
	if (!selected) return null;
	return applyMatching(selected, matchingType);
}

/** The certificate material presented by a peer during the TLS handshake. */
export interface PresentedCertificate {
	/** The end-entity (leaf) certificate DER. */
	leafDer: Buffer;
	/**
	 * The full presented chain (leaf-first), used for DANE-TA(2) matching. When
	 * omitted the chain is taken to be just the leaf.
	 */
	chainDer?: Buffer[];
}

/** The outcome of matching a presented certificate against a TLSA RRset. */
export interface DaneMatchResult {
	/** Whether the RRset contained at least one SMTP-usable (usage 2/3) record. */
	usable: boolean;
	/** Whether a usable record authenticated the presented certificate/chain. */
	matched: boolean;
	/** The record that authenticated the certificate, when `matched` is true. */
	matchedRecord?: TlsaRecord;
}

/**
 * Match a presented certificate (chain) against a published TLSA RRset per
 * RFC 7672. DANE-EE(3) records authenticate ONLY the end-entity certificate;
 * DANE-TA(2) records authenticate any certificate in the presented chain (the
 * trust anchor). Non-SMTP usages (PKIX-TA/EE) are ignored.
 *
 * `usable` reflects whether any SMTP-usable record was present at all (so the
 * caller can distinguish "TLSA says nothing usable → fall back" from "TLSA is in
 * force and DID NOT match → fail closed"). `matched` is the authentication
 * verdict.
 */
export function matchCertificateToTlsa(
	presented: PresentedCertificate,
	records: readonly TlsaRecord[]
): DaneMatchResult {
	const usable = records.filter(isUsableForSmtp);
	if (usable.length === 0) return { usable: false, matched: false };

	const chain =
		presented.chainDer && presented.chainDer.length > 0 ? presented.chainDer : [presented.leafDer];

	for (const record of usable) {
		const candidates = record.usage === DANE_USAGE.DANE_EE ? [presented.leafDer] : chain;
		for (const der of candidates) {
			const assoc = computeAssociation(der, record.selector, record.matchingType);
			if (assoc !== null && assoc === record.data) {
				return { usable: true, matched: true, matchedRecord: record };
			}
		}
	}

	return { usable: true, matched: false };
}
