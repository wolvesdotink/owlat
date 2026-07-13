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
			const issuer: PeerCertificate | undefined = (
				node as PeerCertificate & { issuerCertificate?: PeerCertificate }
			).issuerCertificate;
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
	config: MtaConfig
): Promise<DaneDecision> {
	const mode = config.daneMode ?? 'off';
	if (mode === 'off' || !config.daneResolverUrl) return { kind: 'none' };

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

	const plan: DanePlan = {
		checkServerIdentity: buildDaneCheck(lookup.records),
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
		{ mxHost, recipientDomain, count: lookup.records.length },
		'DANE TLSA in force for MX (supersedes MTA-STS)'
	);
	return { kind: 'proceed', plan };
}
