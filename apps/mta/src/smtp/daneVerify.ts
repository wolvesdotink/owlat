/**
 * DANE (RFC 7672) certificate authentication for outbound delivery.
 *
 * Bridges the TLS handshake to the pure TLSA matcher in `@owlat/shared`: resolves
 * a recipient MX's TLSA RRset, and — when it is usable — produces the peer
 * verifier plus the TLS-RPT policy context the sender needs to authenticate the
 * certificate and attribute the result.
 */

import { createHash, X509Certificate } from 'node:crypto';
import type { PeerCertificate, TLSSocket } from 'node:tls';
import type Redis from 'ioredis';
import {
	computeAssociation,
	formatTlsaRecord,
	hasUsableTlsa,
	matchCertificateToTlsa,
	type TlsaRecord,
} from '@owlat/shared/dane';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { lookupTlsaRecords } from './daneResolver.js';
import { buildTlsaPolicyString, type TlsPolicyContext } from './tlsRpt.js';
import type { DaneMxDestination } from './daneMxResolver.js';

function collectPeerChain(cert: PeerCertificate): Buffer[] {
	const chain: Buffer[] = [];
	const seen = new Set<string>();
	let node: PeerCertificate | undefined = cert;
	while (node?.raw && node.raw.length > 0) {
		const fingerprint = createHash('sha256').update(node.raw).digest('hex');
		if (seen.has(fingerprint)) break;
		seen.add(fingerprint);
		chain.push(node.raw);
		const issuer: PeerCertificate | undefined = (
			node as PeerCertificate & { issuerCertificate?: PeerCertificate }
		).issuerCertificate;
		node = issuer && issuer !== node ? issuer : undefined;
	}
	return chain;
}

function matchesTlsa(certDer: Buffer, record: TlsaRecord): boolean {
	return computeAssociation(certDer, record.selector, record.matchingType) === record.data;
}

function validateDaneTaPath(
	chainDer: readonly Buffer[],
	anchorIndex: number,
	referenceIdentifiers: readonly string[],
	now: number
): Error | undefined {
	let chain: X509Certificate[];
	try {
		chain = chainDer.slice(0, anchorIndex + 1).map((der) => new X509Certificate(der));
	} catch {
		return new Error('DANE-TA validation failed: malformed certificate in peer chain');
	}

	const leaf = chain[0];
	if (!leaf) return new Error('DANE-TA validation failed: peer chain is empty');
	if (!referenceIdentifiers.some((identifier) => leaf.checkHost(identifier) !== undefined)) {
		return new Error('DANE-TA validation failed: MX certificate name mismatch');
	}
	const extendedKeyUsage = leaf.keyUsage;
	if (
		Array.isArray(extendedKeyUsage) &&
		extendedKeyUsage.length > 0 &&
		!extendedKeyUsage.includes('1.3.6.1.5.5.7.3.1') &&
		!extendedKeyUsage.includes('2.5.29.37.0')
	) {
		return new Error('DANE-TA validation failed: certificate is not valid for TLS servers');
	}

	for (const cert of chain) {
		const validFrom = Date.parse(cert.validFrom);
		const validTo = Date.parse(cert.validTo);
		if (
			!Number.isFinite(validFrom) ||
			!Number.isFinite(validTo) ||
			now < validFrom ||
			now > validTo
		) {
			return new Error('DANE-TA validation failed: certificate is outside its validity period');
		}
	}

	const anchor = chain[anchorIndex];
	if (!anchor?.ca) return new Error('DANE-TA validation failed: TLSA trust anchor is not a CA');
	for (let index = 0; index < anchorIndex; index++) {
		const child = chain[index];
		const issuer = chain[index + 1];
		if (!child || !issuer?.ca || !child.checkIssued(issuer) || !child.verify(issuer.publicKey)) {
			return new Error('DANE-TA validation failed: invalid certificate path to TLSA trust anchor');
		}
	}
	return undefined;
}

/**
 * Authenticate a completed TLS handshake against an SMTP DANE RRset.
 *
 * DANE-EE(3) is a direct leaf association and intentionally ignores WebPKI,
 * names, and certificate dates. DANE-TA(2) instead validates the presented
 * chain to the associated CA, including signatures, CA constraints, validity,
 * and the RFC 7672 reference-identifier name check. Any usable association may
 * authenticate the peer, which matters during EE/TA rollover.
 */
export function buildDanePeerVerifier(
	records: readonly TlsaRecord[],
	referenceIdentifiers: readonly string[],
	now: () => number = Date.now
): (socket: TLSSocket) => Error | undefined {
	const daneEeRecords = records.filter((record) => record.usage === 3);
	const daneTaRecords = records.filter((record) => record.usage === 2);
	const normalizedIdentifiers = [...new Set(referenceIdentifiers.map(normalizeHostname))].filter(
		Boolean
	);

	return (socket) => {
		const peer = socket.getPeerCertificate(true);
		if (!peer?.raw || peer.raw.length === 0) {
			return new Error('DANE TLSA check: no peer certificate presented');
		}
		if (
			matchCertificateToTlsa({ leafDer: peer.raw, chainDer: [peer.raw] }, daneEeRecords).matched
		) {
			return undefined;
		}

		const chainDer = collectPeerChain(peer);
		let lastTaError: Error | undefined;
		for (const record of daneTaRecords) {
			for (let anchorIndex = 0; anchorIndex < chainDer.length; anchorIndex++) {
				const candidate = chainDer[anchorIndex];
				if (!candidate || !matchesTlsa(candidate, record)) continue;
				const pathError = validateDaneTaPath(chainDer, anchorIndex, normalizedIdentifiers, now());
				if (!pathError) return undefined;
				lastTaError = pathError;
			}
		}
		return (
			lastTaError ??
			new Error('DANE TLSA mismatch: peer chain did not match any usable TLSA association')
		);
	};
}

function normalizeHostname(hostname: string): string {
	return hostname.trim().toLowerCase().replace(/\.$/, '');
}

/** Stable identity for the complete DANE authentication policy of a connection. */
export function buildDanePolicyFingerprint(
	records: readonly TlsaRecord[],
	referenceIdentifiers: readonly string[]
): string {
	const recordPolicy = records.map(formatTlsaRecord).sort();
	const namePolicy = referenceIdentifiers.map(normalizeHostname).filter(Boolean).sort();
	return createHash('sha256')
		.update(JSON.stringify({ version: 1, records: recordPolicy, names: namePolicy }))
		.digest('hex');
}

/** The per-attempt DANE inputs the sender feeds into one delivery attempt. */
export interface DanePlan {
	/** DANE verifier run after TLS but before SMTP resumes. */
	verifyPeerCertificate: (socket: TLSSocket) => Error | undefined;
	/** Stable pool identity for the TLSA RRset and TA reference names. */
	policyFingerprint: string;
	/** The TLS-RPT policy context (policy-type `tlsa`) to attribute the result to. */
	policyContext: TlsPolicyContext;
}

/**
 * The DANE decision for one recipient MX host (RFC 7672 §2.1):
 *
 *  - `proceed` (enforce mode): a usable, DNSSEC-authenticated TLSA RRset is in
 *    force — attempt delivery with the handshake hook (authenticated TLS required,
 *    no cleartext fallback), superseding MTA-STS.
 *  - `report` (report mode): a usable TLSA RRset was found, but DANE must NOT
 *    require TLS or bounce. The caller runs the same cert-authentication (via
 *    `plan`) purely to OBSERVE the outcome and emit the TLS-RPT result, then lets
 *    delivery proceed on the normal opportunistic/MTA-STS floor regardless.
 *  - `none`: DANE is off (or inert without a resolver), or the MX publishes no
 *    usable TLSA (authenticated denial / unauthenticated answer), or the lookup
 *    failed in report mode — the caller applies its MTA-STS / local-floor policy,
 *    byte-identical to the pre-DANE path.
 *  - `defer` (enforce mode only): the TLSA lookup could not be completed (SERVFAIL
 *    / timeout / transport error). Delivering without DANE here would be a
 *    downgrade, so the caller soft-defers this MX rather than fall through to
 *    cleartext. Report mode never defers (it has zero delivery impact).
 */
export type DaneDecision =
	| { kind: 'proceed'; plan: DanePlan }
	| { kind: 'report'; plan: DanePlan }
	| { kind: 'none' }
	| { kind: 'defer'; reason: string };

/**
 * Decide how to handle DANE for one recipient MX host. Never throws.
 *
 * The DANE mode (`off`/`report`/`enforce`, default `report`) governs the two
 * strict outcomes:
 *
 *  - In `enforce`, a `lookup-failed` TLSA result becomes `defer` (fail-closed):
 *    only an authenticated denial of existence or a non-usable RRset falls through
 *    to the non-DANE path, so a resolver outage or an attacker who suppresses the
 *    TLSA lookup cannot silently strip DANE and downgrade to opportunistic
 *    cleartext; a usable RRset becomes `proceed`.
 *  - In `report`, DANE has zero delivery impact: a usable RRset becomes `report`
 *    (observe + emit only), and a `lookup-failed` becomes `none` (deliver on the
 *    normal policy) — report-only never defers or bounces (honours D6).
 *
 * DANE is inert (returns `none` without any lookup) when the mode is `off` or no
 * resolver is configured — byte-identical to the historic path.
 */
export async function prepareDaneAttempt(
	redis: Redis,
	mxHost: string,
	recipientDomain: string,
	config: MtaConfig,
	destination?: DaneMxDestination
): Promise<DaneDecision> {
	const mode = config.daneMode ?? 'off';
	if (mode === 'off' || !config.daneResolverUrl) return { kind: 'none' };
	if (destination?.addressSecurity === 'indeterminate') {
		const reason = `DANE address discovery indeterminate for ${mxHost}`;
		if (mode === 'enforce') return { kind: 'defer', reason };
		logger.debug(
			{ mxHost, recipientDomain },
			'DANE report-only: address discovery indeterminate; delivery proceeds on the normal policy'
		);
		return { kind: 'none' };
	}
	if (destination?.addressSecurity === 'insecure') {
		logger.debug(
			{ mxHost, recipientDomain, addressSecurity: destination.addressSecurity },
			'DANE skipped because the MX address chain is not DNSSEC-secure'
		);
		return { kind: 'none' };
	}

	const lookup = await lookupTlsaRecords(redis, mxHost, config.daneResolverUrl);

	if (lookup.status === 'lookup-failed') {
		// Report-only must never change delivery: a lookup failure is observed but
		// falls through to the normal policy (no defer, no bounce). Enforce defers
		// (fail-closed) so a suppressed lookup cannot strip DANE (RFC 7672 §2.1).
		if (mode === 'report') {
			logger.debug(
				{ mxHost, recipientDomain, reason: lookup.reason },
				'DANE report-only: TLSA lookup failed; observing only, delivery proceeds on the normal policy'
			);
			return { kind: 'none' };
		}
		logger.warn(
			{ mxHost, recipientDomain, reason: lookup.reason },
			'DANE TLSA lookup failed; deferring rather than downgrading to non-DANE (RFC 7672 §2.1)'
		);
		return { kind: 'defer', reason: `DANE TLSA lookup failed: ${lookup.reason}` };
	}

	if (lookup.status === 'no-tlsa' || !hasUsableTlsa(lookup.records)) {
		return { kind: 'none' };
	}

	const referenceIdentifiers = [mxHost];
	if (destination?.mxSecurity === 'secure') referenceIdentifiers.push(recipientDomain);
	const plan: DanePlan = {
		verifyPeerCertificate: buildDanePeerVerifier(lookup.records, referenceIdentifiers),
		policyFingerprint: buildDanePolicyFingerprint(lookup.records, referenceIdentifiers),
		policyContext: {
			policyType: 'tlsa',
			policyString: buildTlsaPolicyString(lookup.records),
			mxHostPatterns: [mxHost],
		},
	};

	// Report-only: same evaluation, but the caller records the result and delivers
	// on the normal floor — DANE never requires TLS or bounces here.
	if (mode === 'report') {
		logger.debug(
			{ mxHost, recipientDomain, count: lookup.records.length },
			'DANE report-only: usable TLSA — recording the result, delivery unaffected'
		);
		return { kind: 'report', plan };
	}

	logger.debug(
		{
			mxHost,
			recipientDomain,
			count: lookup.records.length,
			mxSecurity: destination?.mxSecurity,
		},
		'DANE TLSA in force for MX (supersedes MTA-STS)'
	);
	return { kind: 'proceed', plan };
}
