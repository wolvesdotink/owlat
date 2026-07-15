/**
 * Pure SMTP/TLS failure classification helpers for the direct-MX sender.
 *
 * Extracted from `sender.ts` so the file stays under the size ratchet and the
 * classification table can be unit-tested in isolation. No I/O, no side effects
 * — given an SMTP error shape, they derive the TLS-RPT result type (RFC 8460)
 * and parse enhanced status codes.
 */

import type { TlsResultType } from './tlsRpt.js';

/**
 * Parse SMTP enhanced status code from error response
 * e.g., "550 5.1.1 User unknown" → "5.1.1"
 */
export function parseEnhancedCode(response: string): string | undefined {
	const match = response.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/);
	return match?.[1];
}

/**
 * Classify an SMTP error as a TLS failure type for TLS-RPT.
 * Returns null if the error is not TLS-related (RFC 8460 §4 — only genuine
 * TLS negotiation problems belong in a report; transport/network errors and
 * application-level SMTP failures must be excluded).
 *
 * Exported for regression testing of the classification table.
 */
export function classifyTlsFailure(error: {
	code?: string;
	message?: string;
	response?: string;
}): TlsResultType | null {
	const msg = (error.message ?? '') + (error.response ?? '');
	const code = error.code ?? '';

	// Inspect the message for a TLS/certificate signature FIRST — BEFORE bailing
	// on transport error codes. nodemailer surfaces a STARTTLS certificate
	// verification failure (self-signed / untrusted / hostname-mismatch /
	// expired, e.g. under MTA-STS enforce with rejectUnauthorized:true) as a
	// generic `code: 'ESOCKET'` error whose MESSAGE carries the real reason
	// ("self-signed certificate", "Hostname/IP does not match certificate's
	// altnames: ..."). Bailing on ESOCKET before reading the message would
	// silently drop exactly these cert failures from TLS-RPT (RFC 8460 §4) —
	// the very negotiation failures a report exists to surface.
	if (msg.includes('STARTTLS') || msg.includes('starttls')) {
		return 'starttls-not-supported';
	}

	if (msg.includes('certificate') || msg.includes('CERT_') || msg.includes('altname')) {
		if (msg.includes('expired')) return 'certificate-expired';
		if (
			msg.includes('hostname') ||
			msg.includes('Hostname') ||
			msg.includes('mismatch') ||
			msg.includes('altname')
		)
			return 'certificate-host-mismatch';
		// Match both the legacy spaced form and Node's hyphenated "self-signed".
		if (
			msg.includes('self signed') ||
			msg.includes('self-signed') ||
			msg.includes('untrusted') ||
			msg.includes('UNABLE_TO_VERIFY')
		)
			return 'certificate-not-trusted';
		return 'validation-failure';
	}

	if (msg.includes('SSL') || msg.includes('TLS') || msg.includes('tls')) {
		return 'validation-failure';
	}

	// Pure transport/network failures (no TLS/cert signature in the message) are
	// not TLS negotiation failures. ESOCKET covers low-level socket errors raised
	// by nodemailer when the connection drops before/around the TLS handshake
	// (e.g. "socket hang up"); those carry no certificate/SSL/TLS marker and so
	// fall through to here.
	if (
		code === 'ECONNREFUSED' ||
		code === 'ECONNRESET' ||
		code === 'ETIMEDOUT' ||
		code === 'ESOCKET'
	) {
		return null; // Network error, not TLS
	}

	return null; // Not a TLS error
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
