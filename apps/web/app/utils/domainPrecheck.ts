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
import { dohQuery, DNS_TYPE_NS, DNS_STATUS_NXDOMAIN } from './doh';

/**
 * Full freemail / public-mailbox domains the operator cannot publish DNS for.
 * Kept as an explicit static set (not a heuristic) so the block only fires on
 * domains we are confident are shared mailbox providers.
 */
const FREEMAIL_DOMAINS = new Set<string>([
	// Google
	'gmail.com',
	'googlemail.com',
	// Microsoft
	'outlook.com',
	'outlook.de',
	'hotmail.com',
	'hotmail.co.uk',
	'hotmail.de',
	'live.com',
	'msn.com',
	// Apple
	'icloud.com',
	'me.com',
	'mac.com',
	// Yahoo / AOL
	'ymail.com',
	'rocketmail.com',
	'aol.com',
	// Proton
	'proton.me',
	'protonmail.com',
	'pm.me',
	// German freemail
	'web.de',
	't-online.de',
	'freenet.de',
	// Other public mailboxes
	'mail.com',
	'zoho.com',
	'fastmail.com',
	'yandex.com',
	'yandex.ru',
	'qq.com',
	'163.com',
	'126.com',
]);

/**
 * First-label brands with many country-code TLDs — matched regardless of the
 * TLD so `gmx.de`, `gmx.net`, `yahoo.co.uk`, `yahoo.fr`, … are all covered
 * without enumerating every variant.
 */
const FREEMAIL_BRAND_LABELS = new Set<string>(['gmx', 'yahoo']);

/** Normalize user input for comparison: trim, lowercase, drop a trailing dot. */
function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * True when `domain` is a known freemail / public-mailbox domain the user does
 * not control and therefore cannot publish sending DNS records for.
 */
export function isFreemailDomain(domain: string): boolean {
	const normalized = normalizeDomain(domain);
	if (!normalized || !normalized.includes('.')) return false;
	if (FREEMAIL_DOMAINS.has(normalized)) return true;
	const firstLabel = normalized.split('.')[0];
	return firstLabel !== undefined && FREEMAIL_BRAND_LABELS.has(firstLabel);
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
