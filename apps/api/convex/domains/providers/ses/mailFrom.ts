/**
 * SES custom MAIL FROM — pure host resolution + record building (X1).
 *
 * SES's per-domain MAIL FROM is a *subdomain of the sending domain* (AWS
 * requirement for a working custom MAIL FROM + DMARC SPF alignment): SES relays
 * the bounce envelope through `feedback-smtp.<region>.amazonses.com`, so the
 * customer publishes an MX + an SPF TXT at that subdomain (RFC 7208 §3.1). This
 * is a DIFFERENT record shape from the built-in MTA's return-path SPF (which
 * authorizes pool IPs on a standalone bounce host via `spf.ts`
 * `buildReturnPathMailFromRecords`) — so X1 builds what SES actually requires
 * rather than reusing the MTA helper.
 *
 * Pure (no AWS / no Convex / no DNS I/O) so both the SES provider adapter's
 * registration and the lifecycle's return-path edit emit the identical config +
 * records for a given host and can't drift.
 */

import type { DnsRecord } from '../../domains';

/** Default MAIL FROM sub-label when a domain sets no explicit return-path host. */
export const SES_DEFAULT_MAIL_FROM_LABEL = 'mail';

/**
 * The resolved SES custom MAIL FROM for a domain: the sub-label the DNS records
 * hang off (relative to the sending domain) and the full MAIL FROM domain passed
 * to SES's `SetIdentityMailFromDomain`.
 */
export interface SesMailFrom {
	/** Label(s) relative to the sending domain, e.g. `mail` or `bounce`. */
	readonly host: string;
	/** Full MAIL FROM domain, e.g. `bounce.example.com`. */
	readonly mailFromDomain: string;
}

/**
 * Resolve the SES custom MAIL FROM for `domain` given an optional per-domain
 * `returnPathHost` override.
 *
 * - Absent override → the historic default `mail.<domain>` (unchanged behavior).
 * - Override that is a strict subdomain of `domain` → that host (the relative
 *   sub-label is what the MX/TXT records hang off).
 * - Override equal to the apex, or NOT under `domain` → `null`: SES can only
 *   authenticate a MAIL FROM that is a subdomain of the sending identity, and a
 *   record outside the domain's zone would be unpublishable + break alignment.
 *
 * Inputs are assumed already normalized (lower-case, no trailing dot — the
 * lifecycle runs them through `asDnsName`); a defensive lower-case is applied.
 */
export function resolveSesMailFrom(domain: string, returnPathHost?: string): SesMailFrom | null {
	const base = domain.trim().toLowerCase();
	const override = returnPathHost?.trim().toLowerCase();

	if (!override) {
		return {
			host: SES_DEFAULT_MAIL_FROM_LABEL,
			mailFromDomain: `${SES_DEFAULT_MAIL_FROM_LABEL}.${base}`,
		};
	}

	// The apex itself can never be the MAIL FROM domain (it would collide with the
	// From-domain's own records), and an out-of-zone host is unusable for SES.
	const suffix = `.${base}`;
	if (override === base || !override.endsWith(suffix)) {
		return null;
	}

	const host = override.slice(0, override.length - suffix.length);
	// Guard against an empty or dotted-empty label (e.g. a leading-dot input that
	// slipped past normalization).
	if (host.length === 0) return null;

	return { host, mailFromDomain: override };
}

/**
 * Build the DNS records SES requires for a custom MAIL FROM subdomain: the MX
 * that routes the bounce envelope to SES's feedback endpoint, and the SPF TXT
 * that authorizes SES to send as that subdomain (AWS SES custom MAIL FROM
 * setup). `host` is relative to the sending domain; `region` is the SES region.
 */
export function buildSesMailFromRecords(host: string, region: string): DnsRecord[] {
	return [
		{
			type: 'MX',
			host,
			value: `feedback-smtp.${region}.amazonses.com`,
			priority: 10,
		},
		{
			type: 'TXT',
			host,
			value: 'v=spf1 include:amazonses.com ~all',
		},
	];
}
