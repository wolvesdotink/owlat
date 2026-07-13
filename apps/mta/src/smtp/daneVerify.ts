/**
 * DANE (RFC 7672) certificate authentication for outbound delivery.
 *
 * Bridges the TLS handshake to the pure TLSA matcher in `@owlat/shared`: resolves
 * a recipient MX's TLSA RRset, and — when it is usable — produces the
 * `checkServerIdentity` hook plus the TLS-RPT policy context the sender needs to
 * authenticate the certificate and attribute the result.
 */

import type { PeerCertificate } from 'node:tls';
import type Redis from 'ioredis';
import { hasUsableTlsa, matchCertificateToTlsa, type TlsaRecord } from '@owlat/shared/dane';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { lookupTlsaRecords } from './daneResolver.js';
import { buildTlsaPolicyString, type TlsPolicyContext } from './tlsRpt.js';

/**
 * Build a TLS `checkServerIdentity` callback that authenticates the MX
 * certificate against a DANE TLSA RRset (RFC 7672). Returns `undefined` (accept
 * the handshake) when a usable TLSA record matches the presented certificate or
 * chain, or an `Error` (abort the handshake) on a mismatch.
 *
 * Node only invokes `checkServerIdentity` on a PKIX-authorized chain, so the DANE
 * path runs with certificate verification ON: the MX certificate must be BOTH
 * publicly trusted AND DANE-matched. A DANE-EE certificate that is not PKIX-valid
 * is therefore deferred (fail-closed) rather than delivered unauthenticated —
 * the safe direction for a security control.
 */
export function buildDaneCheck(
	records: readonly TlsaRecord[]
): (host: string, cert: PeerCertificate) => Error | undefined {
	return (_host, cert) => {
		const leafDer = cert.raw;
		if (!leafDer || leafDer.length === 0) {
			return new Error('DANE TLSA check: no peer certificate presented');
		}

		// Walk the presented chain (leaf → issuer …) for DANE-TA(2) matching. The
		// root certificate's issuerCertificate points back at itself; the seen-set
		// terminates the walk.
		const chainDer: Buffer[] = [];
		const seen = new Set<PeerCertificate>();
		let node: PeerCertificate | undefined = cert;
		while (node && node.raw && node.raw.length > 0 && !seen.has(node)) {
			seen.add(node);
			chainDer.push(node.raw);
			const issuer = (node as PeerCertificate & { issuerCertificate?: PeerCertificate })
				.issuerCertificate;
			node = issuer && issuer !== node ? issuer : undefined;
		}

		const result = matchCertificateToTlsa({ leafDer, chainDer }, records);
		if (result.matched) return undefined;
		return new Error('DANE TLSA mismatch: MX certificate did not match any usable TLSA record');
	};
}

/** The per-attempt DANE inputs the sender feeds into one delivery attempt. */
export interface DanePlan {
	/** The cert-authentication hook for the handshake (a mismatch aborts it). */
	checkServerIdentity: (host: string, cert: PeerCertificate) => Error | undefined;
	/** The TLS-RPT policy context (policy-type `tlsa`) to attribute the result to. */
	policyContext: TlsPolicyContext;
}

/**
 * Prepare the DANE attempt for one recipient MX host. Returns `null` when DANE is
 * disabled or the MX publishes no usable, DNSSEC-authenticated TLSA RRset (the
 * caller then applies its MTA-STS / local-floor policy — byte-identical to the
 * pre-DANE path). Otherwise returns the handshake hook and the tlsa policy
 * context (RFC 7672 supersedes MTA-STS).
 */
export async function prepareDaneAttempt(
	redis: Redis,
	mxHost: string,
	recipientDomain: string,
	config: MtaConfig
): Promise<DanePlan | null> {
	if (!config.daneEnabled || !config.daneResolverUrl) return null;

	const tlsaRecords = await lookupTlsaRecords(redis, mxHost, config.daneResolverUrl);
	if (!hasUsableTlsa(tlsaRecords)) return null;

	logger.debug(
		{ mxHost, recipientDomain, count: tlsaRecords.length },
		'DANE TLSA in force for MX (supersedes MTA-STS)'
	);
	return {
		checkServerIdentity: buildDaneCheck(tlsaRecords),
		policyContext: {
			policyType: 'tlsa',
			policyString: buildTlsaPolicyString(tlsaRecords),
			mxHostPatterns: [mxHost],
		},
	};
}
