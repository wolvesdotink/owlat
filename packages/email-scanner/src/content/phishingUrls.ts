/**
 * Phishing URL Scanner
 *
 * Detects phishing URLs, URL shorteners, and anchor text/href mismatches.
 * Migrated from apps/api/convex/lib/contentScanner.ts with enhancements.
 */

import type { ContentFlag } from '../types.js';
import { registerContentRule } from './rule.js';
import { decodeHtmlEntities } from './htmlEntities.js';

/** Known phishing domains and patterns */
const PHISHING_DOMAIN_PATTERNS: RegExp[] = [
	// Typosquatting of major brands
	/paypa[l1i]\.(?!com)/i,
	/amaz[o0]n\.(?!com)/i,
	/g[o0]{2}gle\.(?!com)/i,
	/micros[o0]ft\.(?!com)/i,
	/app[l1]e\.(?!com)/i,
	/faceb[o0]{2}k\.(?!com)/i,
	// Suspicious TLDs commonly used in phishing
	/\.(xyz|top|club|buzz|icu|work|monster|quest|sbs)\b/i,
];

/** URL shortener domains (legitimate senders use their own domains) */
const URL_SHORTENERS = new Set([
	'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 't.co', 'is.gd',
	'buff.ly', 'adf.ly', 'bl.ink', 'lnkd.in', 'soo.gd', 'clck.ru',
	's.id', 'cutt.ly', 'rb.gy', 'shorturl.at', 'tiny.cc',
]);

/**
 * Extract all URLs from HTML content.
 */
export function extractUrls(html: string): Array<{ href: string; text: string }> {
	const urls: Array<{ href: string; text: string }> = [];
	// Match href values that are double-quoted, single-quoted, or unquoted
	// (HTML5 allows `<a href=http://evil.com>`). Unquoted values run up to the
	// next whitespace or `>`; otherwise unquoted hrefs would be invisible to
	// every downstream URL check (phishing/mismatch/homoglyph/Safe Browsing).
	const linkRegex =
		/<a\s+[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a>/gi;
	let match;
	while ((match = linkRegex.exec(html)) !== null) {
		const href = match[1] ?? match[2] ?? match[3] ?? '';
		// Strip HTML tags from link text
		const text = (match[4] ?? '').replace(/<[^>]+>/g, '').trim();
		urls.push({ href, text });
	}
	return urls;
}

/**
 * Extract domain from URL.
 */
export function extractDomain(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.hostname.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Normalize a URL by decoding percent-encoded characters and HTML entities.
 * Prevents bypass via encoded domains like `paypal%2ecom` or `paypal&#46;com`.
 */
function normalizeHref(href: string): string {
	// Trim surrounding whitespace so schemes like ` javascript:` (which browsers
	// tolerate) cannot evade the dangerous-scheme check below.
	let normalized = decodeHtmlEntities(href.trim())
		.replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => String.fromCharCode(parseInt(code, 16)));
	// Decode percent-encoded characters (handles %2e → . etc.)
	try {
		normalized = decodeURIComponent(normalized);
	} catch {
		// Malformed encoding — use as-is
	}
	return normalized;
}

/**
 * Scan URLs for phishing patterns, URL shorteners, and anchor mismatches.
 */
export function scanPhishingUrls(html: string): ContentFlag[] {
	const flags: ContentFlag[] = [];
	const urls = extractUrls(html);

	for (const { href: rawHref, text } of urls) {
		// Normalize href to prevent bypass via encoded characters
		const href = normalizeHref(rawHref);

		// Check for data: and javascript: URIs
		if (href.startsWith('data:') || href.startsWith('javascript:')) {
			flags.push({
				type: 'phishing_url',
				severity: 'high',
				description: `Dangerous URI scheme detected: ${href.substring(0, 30)}...`,
				match: href,
			});
			continue;
		}

		const domain = extractDomain(href);
		if (!domain) continue;

		// Check for URL shorteners
		if (URL_SHORTENERS.has(domain)) {
			flags.push({
				type: 'url_shortener',
				severity: 'medium',
				description: `URL shortener detected: ${domain}. Use your own domain for links.`,
				match: href,
			});
		}

		// Check for known phishing domain patterns
		for (const pattern of PHISHING_DOMAIN_PATTERNS) {
			if (pattern.test(domain)) {
				flags.push({
					type: 'phishing_url',
					severity: 'high',
					description: `Potentially phishing URL detected: ${domain}`,
					match: href,
				});
				break;
			}
		}

		// Check for anchor text / href mismatch (phishing pattern)
		if (text) {
			const textDomain = extractDomain(
				text.startsWith('http') ? text : `https://${text}`
			);
			if (textDomain && domain !== textDomain && text.includes('.')) {
				flags.push({
					type: 'url_mismatch',
					severity: 'high',
					description: `Link text "${text}" doesn't match actual URL domain "${domain}" — possible phishing`,
					match: href,
				});
			}
		}
	}

	return flags;
}

registerContentRule({
	id: 'phishing-urls',
	scan: ({ html }) => scanPhishingUrls(html),
});
