/**
 * Pure TLS failure classification helpers for the direct-MX sender.
 *
 * The @owlat/smtp-client engine classifies every TLS/handshake failure AT THE
 * SOURCE, from Node's machine-readable error codes, into a structured
 * {@link SmtpTlsCause} on the thrown {@link SmtpError}. This module is the thin,
 * total map from that discriminant onto the TLS-RPT {@link TlsResultType} the
 * sender records (RFC 8460) — NO string-matching, NO error-message sniffing
 * (locked decision W7). The historic old-library-shaped classifier
 * (`error.code === 'ETLS'`, `response`/`message` substring tables) is gone.
 */

import type { SmtpTlsCause } from '@owlat/smtp-client';
import type { TlsResultType } from './tlsRpt.js';

/**
 * Map a structured {@link SmtpTlsCause} onto its TLS-RPT result type (RFC 8460
 * §4.3). Total over the discriminant — a new cause must be classified here
 * explicitly (the exhaustive `never` guard trips the typecheck otherwise).
 *
 * `handshake` (an opaque negotiation / protocol failure, and the cause a DANE
 * peer-verifier mismatch surfaces) maps to the generic `validation-failure`;
 * `starttls-unavailable` (a required STARTTLS the MX did not offer or refused)
 * maps to `starttls-not-supported`.
 */
export function classifyTlsFailure(cause: SmtpTlsCause): TlsResultType {
	switch (cause) {
		case 'cert-expired':
			return 'certificate-expired';
		case 'cert-host-mismatch':
			return 'certificate-host-mismatch';
		case 'cert-untrusted':
			return 'certificate-not-trusted';
		case 'starttls-unavailable':
			return 'starttls-not-supported';
		case 'handshake':
			return 'validation-failure';
		default: {
			const _exhaustive: never = cause;
			return _exhaustive;
		}
	}
}

/**
 * Escalate a generic TLS failure to its MTA-STS-specific TLS-RPT result type
 * when an STS policy is in force (RFC 8460 §4.4).
 *
 * - No STS policy ('none'): keep the generic result type.
 * - STS in force ('enforce' or 'testing'): a certificate/WebPKI verification
 *   failure under STS is `sts-webpki-invalid`; any other TLS failure (e.g.
 *   STARTTLS stripping, protocol/validation failure) is `sts-policy-invalid`.
 *
 * Testing mode still attributes the STS type so report-only days surface the
 * same failures an enforce policy would have caught (RFC 8460 §4.3).
 */
export function stsAttributedResultType(
	baseType: TlsResultType,
	policyMode: 'enforce' | 'testing' | 'none'
): TlsResultType {
	if (policyMode === 'none') return baseType;

	const isWebPkiFailure =
		baseType === 'certificate-host-mismatch' ||
		baseType === 'certificate-expired' ||
		baseType === 'certificate-not-trusted' ||
		baseType === 'validation-failure';

	return isWebPkiFailure ? 'sts-webpki-invalid' : 'sts-policy-invalid';
}
