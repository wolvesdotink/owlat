/**
 * SMTP TLS Reporting (TLS-RPT) — pure record builder for the operator's own
 * `_smtp._tls` TXT record (RFC 8460 §3).
 *
 * TLS-RPT lets a sending domain advertise where receivers should send daily
 * aggregate reports about TLS-negotiation failures when delivering mail TO the
 * operator's domain. The MTA already *consumes* recipients' STS/TLS-RPT policy
 * when sending outbound; this record is the reciprocal — it asks others to
 * report failures back to the operator so they can spot downgrade attacks and
 * misconfigured TLS on their own MX.
 *
 * The `rua=` reporting tag is only emitted when the operator has configured a
 * destination they actually monitor (`MTA_TLSRPT_RUA`, threaded in as
 * `ruaAddress` by the MTA provider adapter). Owlat does not provision a
 * `tls-reports@<customer-domain>` mailbox, so hardcoding an address would point
 * reports at an inbox nobody reads — we omit the whole record unless the
 * operator opts in (`buildTlsRptRecordValue` returns `undefined`). The address
 * is emitted verbatim and is expected to be an RFC-8460 reporting URI such as
 * `mailto:tls-reports@example.com` or `https://example.com/tlsrpt`.
 */

/** Host label for the SMTP TLS Reporting policy record (RFC 8460 §3). */
export const TLSRPT_HOST = '_smtp._tls';

/**
 * Build the `_smtp._tls` TXT record value for a domain.
 *
 * Returns `undefined` when no reporting destination is configured (or it is
 * empty/whitespace-only), so the caller omits the record entirely.
 */
export function buildTlsRptRecordValue(ruaAddress?: string): string | undefined {
	const rua = ruaAddress?.trim();
	if (!rua) return undefined;
	return `v=TLSRPTv1; rua=${rua}`;
}
