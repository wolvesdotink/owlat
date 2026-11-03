/**
 * Sending-domain pre-checks for the "Add Sending Domain" modal
 * (Settings → Domains). Two common mistakes are caught BEFORE the user wastes
 * time on DNS records they can never publish:
 *
 *  1. `isFreemailDomain` — a freemail / public-mailbox domain the user does not
 *     control (gmail.com, outlook.com, gmx.*, web.de, proton.me, …). You cannot
 *     add TXT/CNAME records to someone else's zone, so this is a *blocking*
 *     warning that points at the connect-an-external-mailbox path instead.
 *
 *  2. `resolveNs` — a fail-soft DoH lookup that flags a domain which simply does
 *     not exist (NXDOMAIN, usually a typo). This is *advisory*: DNS may be
 *     mid-provisioning, so submit is still allowed.
 *
 * Out of scope: WHOIS / registrar ownership checks.
 */
import { isFreemailDomain } from '@owlat/shared/freemailDomains';
import { dohQuery, DNS_TYPE_NS, DNS_STATUS_NXDOMAIN } from './doh';

/**
 * Freemail / public-mailbox domains the operator cannot publish DNS for. The
 * list lives in `@owlat/shared/freemailDomains`, which the Postbox also uses
 * to keep brand logos off webmail senders.
 */
export { isFreemailDomain };

/** Normalize user input for comparison: trim, lowercase, drop a trailing dot. */
function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * Fail-soft DoH nameserver check for `domain`. Returns:
 *
 *  - `true`  — the domain publishes NS records (it resolves; nothing to warn).
 *  - `false` — the name does not exist (NXDOMAIN); almost always a typo.
 *  - `null`  — indeterminate: a lookup / parse error (fail-soft), or a name that
 *              exists but delegates no NS of its own (a subdomain such as
 *              `mail.example.com` — expected, so we do NOT warn).
 *
 * Callers soft-warn only on `false`; `null` and `true` stay silent. Never
 * throws.
 */
export async function resolveNs(domain: string): Promise<boolean | null> {
	const normalized = normalizeDomain(domain);
	if (!normalized || !normalized.includes('.')) return null;
	const body = await dohQuery(normalized, 'NS');
	if (!body) return null; // lookup failed — fail soft, stay silent
	if ((body.Answer ?? []).some((answer) => answer.type === DNS_TYPE_NS)) return true;
	if (body.Status === DNS_STATUS_NXDOMAIN) return false;
	// NOERROR without NS answers (e.g. a subdomain) — can't tell, don't warn.
	return null;
}
