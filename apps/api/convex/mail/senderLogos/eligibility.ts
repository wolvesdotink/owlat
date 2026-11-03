/**
 * Which messages may show a brand logo, and under which domain it is cached.
 *
 * A logo is a claim that the brand sent the message, so it is shown only when
 * the message proves it: DMARC passed for the visible From domain on this
 * message. Everything else keeps its initials, which is what makes the logo a
 * phishing signal: a spoofed bank mail looks different from the real one.
 *
 * Not a logo, whatever the verdict says:
 *   - an ARC rescue: a forwarder vouched for the original pass, the From
 *     domain did not prove anything to us;
 *   - spam, quarantine or an infected attachment;
 *   - a From domain the ingest heuristics flagged as spoofing a real one or
 *     looking like a contact's domain;
 *   - a freemail domain: a pass from gmail.com proves Gmail sent it, not that
 *     the writer is Google.
 *
 * Pure. The cache key is the organisational domain (private PSL entries
 * included), so subdomains of one sender share a logo and two tenants of a
 * hosting suffix never do.
 */

import { organizationalDomain } from '@owlat/shared/dnsZone';
import { isFreemailDomain } from '@owlat/shared/freemailDomains';
import type { Doc } from '../../_generated/dataModel';

export type SenderLogoInput = Pick<
	Doc<'mailMessages'>,
	| 'fromAddress'
	| 'dmarcResult'
	| 'dmarcOverride'
	| 'senderHeuristics'
	| 'spamVerdict'
	| 'virusVerdict'
>;

/** The domain after the last `@`, or `null` for an address without one. */
function domainOfAddress(address: string): string | null {
	const at = address.lastIndexOf('@');
	if (at < 0 || at === address.length - 1) return null;
	return address.slice(at + 1);
}

/** The organisational domain whose logo this message may show, or `null`. */
export function senderLogoDomain(message: SenderLogoInput): string | null {
	if (message.dmarcResult?.trim().toLowerCase() !== 'pass') return null;
	if (message.dmarcOverride !== undefined) return null;
	if (message.spamVerdict !== undefined && message.spamVerdict !== 'ham') return null;
	if (message.virusVerdict === 'infected') return null;
	const heuristics = message.senderHeuristics;
	if (heuristics?.isFromDomainSpoofed || heuristics?.lookalikeOfContactDomain) return null;

	const fromDomain = domainOfAddress(message.fromAddress.trim());
	if (fromDomain === null) return null;
	const domain = organizationalDomain(fromDomain);
	if (domain === null) return null;
	if (isFreemailDomain(fromDomain) || isFreemailDomain(domain)) return null;
	return domain;
}

/** Top-level names reserved for tests and local use (RFC 2606, RFC 6761). */
const RESERVED_TLDS: ReadonlySet<string> = new Set([
	'example',
	'test',
	'invalid',
	'localhost',
	'local',
]);
const RESERVED_DOMAINS: ReadonlySet<string> = new Set([
	'example.com',
	'example.net',
	'example.org',
]);

/**
 * Whether a lookup may go out for `domain`. Reserved names belong to no
 * brand, so asking them is only ever wasted traffic, and fixtures and demo
 * data use them, which keeps their deliveries off the network.
 */
export function isLookupDomain(domain: string): boolean {
	const tld = domain.slice(domain.lastIndexOf('.') + 1);
	return !RESERVED_TLDS.has(tld) && !RESERVED_DOMAINS.has(domain);
}
