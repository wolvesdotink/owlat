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

import { escapeHtml } from './html';
import { isTrackingParamName } from './postboxLinkTrackingParams';

const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

/**
 * One parsed attribute. `value` is entity-DECODED text (or null for a bare
 * boolean attribute); serialization re-escapes it.
 */
type ParsedAttr = { name: string; value: string | null };

/**
 * Sequential attribute tokenizer. Walks the tag's attribute string left to
 * right consuming one `name` / `name="value"` / `name='value'` /
 * `name=value` token at a time, so a literal `href=` or `title=` INSIDE a
 * quoted value of another attribute can never be mistaken for a real
 * attribute (regex-scanning the whole blob had exactly that flaw, letting a
 * sender forge the tooltip host via e.g. `name="x href=https://trusted.com"`).
 */
const ATTR_TOKEN_RE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(attrs: string): ParsedAttr[] {
	const parsed: ParsedAttr[] = [];
	for (const m of attrs.matchAll(ATTR_TOKEN_RE)) {
		const raw = m[2] ?? m[3] ?? m[4] ?? null;
		parsed.push({ name: m[1] as string, value: raw === null ? null : decodeBasicEntities(raw) });
	}
	return parsed;
}

/** Serialize parsed attributes back to `name="escaped"` form. */
function serializeAttrs(attrs: ParsedAttr[]): string {
	return attrs
		.map((a) => (a.value === null ? a.name : `${a.name}="${escapeHtml(a.value)}"`))
		.join(' ');
}

/**
 * Decode the handful of entities sanitize-html emits inside attribute values
 * (`&amp;` deliberately LAST so `&amp;lt;` decodes to `&lt;`, not `<`).
 */
function decodeBasicEntities(value: string): string {
	return value
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&amp;/gi, '&');
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
				const parsed = parseAttrs(attrs);
				const hrefAttr = parsed.find((a) => a.name.toLowerCase() === 'href');
				if (!hrefAttr || hrefAttr.value === null) return match;
				const href = hrefAttr.value;
				const host = hostOf(href);
				// mailto:/tel:/relative links: nothing to disclose.
				if (!host) return match;

				const cleanedHref = stripTrackingParams(href);
				if (cleanedHref !== href) hrefAttr.value = cleanedHref;

				// Native tooltip with the real destination host. Always replace a
				// sender-supplied title — it can claim anything.
				const kept = parsed.filter((a) => a.name.toLowerCase() !== 'title');
				kept.push({ name: 'title', value: host });

				// Phish pattern: visible text says one host, href goes to another.
				const claimed = textClaimedHost(visibleTextOf(inner));
				const marker =
					claimed && claimed !== normalizeHost(host) ? mismatchMarker(host) : '';

				return `<a ${serializeAttrs(kept)}>${inner}${marker}</a>`;
			} catch {
				return match;
			}
		});
	} catch {
		return sanitizedHtml;
	}
}
