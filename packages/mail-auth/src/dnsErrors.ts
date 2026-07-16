/**
 * Shared classification of DNS resolver rejections.
 *
 * `dns/promises` signals "no such record" by REJECTING with an error whose
 * `code` is one of a small permanent set (NXDOMAIN / NODATA family) rather than
 * resolving an empty array. Several layers key off exactly this distinction —
 * the DKIM verifier (a no-record key lookup → `permerror`), the inbound-auth
 * DNS cache layer (→ a negative-cached empty answer), and the MTA resolver
 * factory — so the predicate lives here, imported by all of them, to keep them
 * from drifting apart.
 */

/** DNS error codes that mean "no such record" — a permanent failure. */
const PERMANENT_DNS_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'NOTFOUND']);

/**
 * True when a DNS resolver rejection means "no such record" (NXDOMAIN / NODATA)
 * rather than a transient failure (SERVFAIL, timeout).
 */
export function isNoRecordDnsError(err: unknown): boolean {
	const code =
		typeof err === 'object' && err !== null && 'code' in err
			? String((err as { code: unknown }).code)
			: '';
	return PERMANENT_DNS_CODES.has(code);
}
