/**
 * Honest link destinations for Postbox received mail.
 *
 * Pure string functions over ALREADY-SANITIZED HTML (the output of
 * sanitize-html with `POSTBOX_SANITIZE_CONFIG`) — this module is a transform
 * on sanitized output and deliberately does NOT touch the sanitizer allowlist
 * or make any network call. It powers:
 *   - a native tooltip on every link showing the real destination host
 *     (`title` works inside the sandboxed iframe where JS tooltips cannot),
 *   - an inline " → real-host.com" marker when the anchor's VISIBLE text
 *     looks like a URL/domain whose host differs from the href host — the
 *     classic phishing pattern,
 *   - stripping well-known tracking query params (utm_*, fbclid, gclid,
 *     mc_eid — see `postboxLinkTrackingParams.ts`) from https hrefs without
 *     changing host or path.
 *
 * Everything fails soft: on any unexpected error each anchor (and the whole
 * transform) returns its input unchanged, so the reader behaves exactly as it
 * did before this feature existed. The injected markup uses only tags,
 * attributes, and style properties already permitted by
 * `POSTBOX_SANITIZE_CONFIG` (an <a title> and a <span style="color/font-size">).
 */

import { isTrackingParamName } from './postboxLinkTrackingParams';

const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

/** Extract an attribute value from a single tag's attribute string. */
function attrValue(attrs: string, name: string): string | null {
	const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
	const m = attrs.match(re);
	if (!m) return null;
	return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Remove an attribute (however quoted) from a tag's attribute string. */
function removeAttr(attrs: string, name: string): string {
	return attrs.replace(
		new RegExp(`\\s*\\b${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'gi'),
		''
	);
}

/** Minimal escape for text injected into an HTML attribute or text node. */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** Decode the handful of entities sanitize-html emits inside href values. */
function decodeBasicEntities(value: string): string {
	return value
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
}

/** Lowercased host of an http(s) URL string, or null when not parseable. */
function hostOf(url: string): string | null {
	if (!/^https?:\/\//i.test(url)) return null;
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/** Normalize a host for text-vs-href comparison (drop a leading `www.`). */
function normalizeHost(host: string): string {
	return host.toLowerCase().replace(/^www\./, '');
}

/**
 * Strip known tracking query params (utm_*, fbclid, gclid, mc_eid) from an
 * https URL. Pure rewrite: host, path, hash, and all other params are kept.
 * Fails soft: a URL that does not parse is returned unchanged.
 */
export function stripTrackingParams(url: string): string {
	if (!/^https:\/\//i.test(url)) return url;
	try {
		const parsed = new URL(url);
		let changed = false;
		for (const name of [...parsed.searchParams.keys()]) {
			if (!isTrackingParamName(name)) continue;
			parsed.searchParams.delete(name);
			changed = true;
		}
		if (!changed) return url;
		// Drop a dangling `?` when every param was tracking noise.
		if ([...parsed.searchParams.keys()].length === 0) parsed.search = '';
		return parsed.toString();
	} catch {
		return url;
	}
}

/**
 * Host the anchor's visible text CLAIMS to point at, or null when the text
 * does not look like a URL/domain. Accepts `https://x.com/...`, `www.x.com`,
 * and bare `x.com/path` shapes.
 */
export function textClaimedHost(visibleText: string): string | null {
	const text = visibleText.trim();
	if (!text || text.length > 2048) return null;
	// Full URL text: parse it properly.
	if (/^https?:\/\//i.test(text)) {
		const host = hostOf(text);
		return host ? normalizeHost(host) : null;
	}
	// Bare domain (optionally with path/query): must start with a plausible
	// hostname followed by end-of-text or a URL delimiter. Require a letter in
	// the TLD so "1.5" or "v2.0" never match.
	const m = text.match(
		/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24})(?:[/?#:]|$)/i
	);
	if (!m?.[1]) return null;
	return normalizeHost(m[1]);
}

/** Visible text of an anchor's inner HTML (tags removed, entities decoded). */
function visibleTextOf(innerHtml: string): string {
	return decodeBasicEntities(innerHtml.replace(/<[^>]*>/g, ' ')).trim();
}

/** Muted inline marker exposing the real destination host of a deceptive link. */
function mismatchMarker(realHost: string): string {
	return ` <span style="color:#8a8a8a;font-size:0.85em">→ ${escapeHtml(realHost)}</span>`;
}

/**
 * Apply link transparency to sanitized message HTML:
 *   1. every http(s) <a> gets `title="<real host>"` (replacing any
 *      sender-supplied title, which could itself lie),
 *   2. anchors whose visible text names a DIFFERENT host than the href get an
 *      inline " → real-host" marker,
 *   3. https hrefs lose known tracking query params.
 *
 * Runs on sanitized output only; injected markup stays within the sanitizer
 * allowlist. Fails soft per-anchor and overall: any error leaves the input
 * unchanged.
 */
export function applyLinkTransparency(sanitizedHtml: string): string {
	try {
		return sanitizedHtml.replace(ANCHOR_RE, (match, attrs: string, inner: string) => {
			try {
				const rawHref = attrValue(attrs, 'href');
				if (!rawHref) return match;
				const href = decodeBasicEntities(rawHref);
				const host = hostOf(href);
				// mailto:/tel:/relative links: nothing to disclose.
				if (!host) return match;

				const cleanedHref = stripTrackingParams(href);
				let newAttrs = attrs;
				if (cleanedHref !== href) {
					newAttrs = removeAttr(newAttrs, 'href');
					newAttrs = `${newAttrs} href="${escapeHtml(cleanedHref)}"`;
				}

				// Native tooltip with the real destination host. Always replace a
				// sender-supplied title — it can claim anything.
				newAttrs = removeAttr(newAttrs, 'title');
				newAttrs = `${newAttrs} title="${escapeHtml(host)}"`;

				// Phish pattern: visible text says one host, href goes to another.
				const claimed = textClaimedHost(visibleTextOf(inner));
				const marker =
					claimed && claimed !== normalizeHost(host) ? mismatchMarker(host) : '';

				return `<a ${newAttrs.trim()}>${inner}${marker}</a>`;
			} catch {
				return match;
			}
		});
	} catch {
		return sanitizedHtml;
	}
}
