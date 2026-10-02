/**
 * Sort the email's links into the ones the server can probe and the ones that
 * are checked here, by their shape alone: an empty or `#` address, a mailto
 * that is not an address, a merge tag the send cannot fill, an address without
 * its scheme.
 */
import { isValidEmail } from '@owlat/shared';
import type { LocalizedText } from '~/utils/localizedText';
import { hasMergeTag, mergeTagsWellFormed, withoutMergeTags, type ScannedLink } from './scanHtml';

const REASON = 'components.campaigns.presendChecks.reasons';

/** At most this many links and images go to the server per run (`presendChecks.ts`). */
export const MAX_PROBED_LINKS = 200;
export const MAX_PROBED_IMAGES = 100;
const MAX_URL_CHARS = 2048;

export interface LinkPlan {
	/** Probe-ready URL → the href it came from (for "Show me"). */
	probes: Map<string, string>;
	/** Links the shape check flagged. */
	malformed: Array<{ href: string; reason: LocalizedText }>;
	/** Web links not probed: personalized past the query string, or over the cap. */
	notProbed: number;
}

const isWeb = (href: string) => /^https?:\/\//i.test(href);

/** Why a link's shape is wrong, or `null` when it is fine. */
export function malformedReason(href: string): LocalizedText | null {
	const value = href.trim();
	if (!value) return `${REASON}.emptyHref`;
	if (value === '#') return `${REASON}.hashHref`;
	if (!mergeTagsWellFormed(value)) return `${REASON}.brokenMergeTag`;
	if (/^mailto:/i.test(value)) {
		let address: string;
		try {
			address = decodeURIComponent(value.slice(7).split('?')[0] ?? '');
		} catch {
			return `${REASON}.invalidMailto`;
		}
		return hasMergeTag(address) || address.split(',').every((part) => isValidEmail(part.trim()))
			? null
			: `${REASON}.invalidMailto`;
	}
	if (isWeb(value) || /^(tel|sms):/i.test(value) || value.startsWith('#')) return null;
	// A whole-address merge tag is filled per recipient; its shape is unknown here.
	if (/^\{\{\w+(\|'[^']*')?\}\}$/.test(value)) return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return `${REASON}.unsupportedScheme`;
	return `${REASON}.relativeUrl`;
}

/**
 * The URL to probe for a web link: as written, or with merge tags dropped
 * when they only sit in the query string (they change a parameter, not the
 * page). `null` when the link is personalized in its host or path.
 */
function probeUrl(href: string): string | null {
	const value = href.trim();
	if (!hasMergeTag(value)) return value;
	const query = value.indexOf('?');
	if (query === -1 || hasMergeTag(value.slice(0, query))) return null;
	return withoutMergeTags(value);
}

export function planLinks(links: readonly ScannedLink[]): LinkPlan {
	const probes = new Map<string, string>();
	const malformed: LinkPlan['malformed'] = [];
	let notProbed = 0;
	for (const link of links) {
		const reason = malformedReason(link.href);
		if (reason) {
			malformed.push({ href: link.href, reason });
			continue;
		}
		if (!isWeb(link.href.trim())) continue;
		const url = probeUrl(link.href);
		if (!url || url.length > MAX_URL_CHARS) {
			notProbed++;
			continue;
		}
		if (probes.has(url)) continue;
		if (probes.size >= MAX_PROBED_LINKS) {
			notProbed++;
			continue;
		}
		probes.set(url, link.href);
	}
	return { probes, malformed, notProbed };
}

/** The image URLs to measure: web images only, deduplicated, capped. */
export function planImages(sources: readonly string[]): string[] {
	const unique = [...new Set(sources.map((src) => src.trim()))].filter(
		(src) => isWeb(src) && !hasMergeTag(src) && src.length <= MAX_URL_CHARS
	);
	return unique.slice(0, MAX_PROBED_IMAGES);
}

/** Link text or address that reads as an opt-out, in the languages Owlat ships. */
const UNSUBSCRIBE =
	/unsubscribe|opt[\s-]?out|manage (your )?(preferences|subscription)|abmelden|abbestellen|austragen|newsletter-einstellungen/i;

export function hasUnsubscribeLink(links: readonly ScannedLink[]): boolean {
	return links.some((link) => UNSUBSCRIBE.test(`${link.text} ${link.href}`));
}
