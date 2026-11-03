/**
 * Freemail and public-mailbox domains: zones where anyone can get an address
 * and nobody but the provider publishes DNS.
 *
 * Shared because two rules depend on the same list. The Add Domain form blocks
 * these zones (the operator cannot publish records there), and the Postbox
 * shows no brand logo for a sender on one of them: a DMARC pass from
 * gmail.com proves the mail came from Gmail, not that the person writing is
 * Google.
 *
 * Kept as an explicit static set, not a heuristic, so a rule only fires on
 * domains we are confident are shared mailbox providers.
 */

const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
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
	'posteo.de',
	'mailbox.org',
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
 * First-label brands with many country-code TLDs, matched regardless of the
 * TLD so `gmx.de`, `gmx.net`, `yahoo.co.uk`, `yahoo.fr`, … are all covered
 * without enumerating every variant.
 */
const FREEMAIL_BRAND_LABELS: ReadonlySet<string> = new Set(['gmx', 'yahoo']);

/** Trim, lowercase and drop a trailing dot. */
function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase().replace(/\.+$/, '');
}

/** True when `domain` is a known freemail / public-mailbox domain. */
export function isFreemailDomain(domain: string): boolean {
	const normalized = normalizeDomain(domain);
	if (!normalized || !normalized.includes('.')) return false;
	if (FREEMAIL_DOMAINS.has(normalized)) return true;
	const firstLabel = normalized.split('.')[0];
	return firstLabel !== undefined && FREEMAIL_BRAND_LABELS.has(firstLabel);
}
