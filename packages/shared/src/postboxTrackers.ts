/**
 * Tracking-pixel detection for Postbox received mail (Apple-Mail-Privacy-style
 * transparency).
 *
 * Pure string functions over ALREADY-SANITIZED HTML (the output of
 * sanitize-html with `POSTBOX_SANITIZE_CONFIG`) — this module is a transform
 * on sanitized output and deliberately does NOT touch the sanitizer allowlist
 * or make any network call. It powers:
 *   - the "Images blocked — N tracking pixels detected" banner,
 *   - keeping pixels stripped when the user clicks "Show images"
 *     (with a separate "load everything" escalation),
 *   - the shield badge naming the tracker hosts.
 *
 * Heuristics (an <img> with a remote http(s) src is flagged when ANY holds):
 *   - declared 0/1px size via width/height attributes or inline style,
 *   - `display:none` in inline style,
 *   - src host matches a well-known open-tracker pattern
 *     (see `postboxTrackerHosts.ts`).
 *
 * `data:`/`cid:` images are never flagged — they cannot phone home.
 *
 * Everything fails soft: on any unexpected error the detector reports zero
 * trackers and the strip transform returns its input unchanged, so the reader
 * behaves exactly as it did before this feature existed.
 */

import { TRACKER_HOST_PATTERNS } from './postboxTrackerHosts';

export interface TrackerDetection {
	/** Number of probable tracking-pixel <img> tags in the sanitized HTML. */
	pixelCount: number;
	/** Deduped, sorted hosts of the flagged images (for the badge popover). */
	trackerHosts: string[];
}

export const EMPTY_TRACKER_DETECTION: TrackerDetection = Object.freeze({
	pixelCount: 0,
	trackerHosts: [],
});

const IMG_TAG_RE = /<img\b[^>]*>/gi;

/** Extract an attribute value from a single tag string (quoted or bare). */
function attrValue(tag: string, name: string): string | null {
	const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
	const m = tag.match(re);
	if (!m) return null;
	return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Read one property value out of an inline style string. */
function styleProp(style: string, prop: string): string | null {
	for (const decl of style.split(';')) {
		const idx = decl.indexOf(':');
		if (idx === -1) continue;
		if (decl.slice(0, idx).trim().toLowerCase() === prop) {
			return decl.slice(idx + 1).trim();
		}
	}
	return null;
}

/** True when a declared dimension is 0 or 1 (px or unitless). */
function isPixelSize(value: string | null): boolean {
	if (value == null) return false;
	const n = Number.parseFloat(value);
	return Number.isFinite(n) && n <= 1;
}

/** True when a declared dimension is larger than a pixel. */
function isVisibleSize(value: string | null): boolean {
	if (value == null) return false;
	const n = Number.parseFloat(value);
	return Number.isFinite(n) && n > 1;
}

/** Host of a remote http(s) img src, or null for data:/cid:/relative/no src. */
function remoteSrcHost(tag: string): string | null {
	const src = attrValue(tag, 'src');
	if (!src || !/^https?:\/\//i.test(src)) return null;
	try {
		return new URL(src).hostname.toLowerCase();
	} catch {
		return null;
	}
}

function isKnownTrackerHost(host: string): boolean {
	return TRACKER_HOST_PATTERNS.some(
		(pattern) => host === pattern || host.endsWith(`.${pattern}`)
	);
}

/** Classify one <img ...> tag string. Exported for the strip transform + tests. */
export function isTrackingPixelTag(tag: string): boolean {
	const host = remoteSrcHost(tag);
	// No remote fetch -> cannot track, regardless of size/visibility.
	if (!host) return false;

	if (isKnownTrackerHost(host)) return true;

	const style = attrValue(tag, 'style') ?? '';
	if (/display\s*:\s*none/i.test(style)) return true;

	const widths = [attrValue(tag, 'width'), styleProp(style, 'width')];
	const heights = [attrValue(tag, 'height'), styleProp(style, 'height')];
	const dims = [...widths, ...heights];
	// Pixel-sized: at least one declared 0/1px dimension and none larger.
	return dims.some(isPixelSize) && !dims.some(isVisibleSize);
}

/**
 * Detect probable tracking pixels in sanitized message HTML.
 * Fails soft: any unexpected error reports zero trackers.
 */
export function detectTrackers(sanitizedHtml: string): TrackerDetection {
	try {
		let pixelCount = 0;
		const hosts = new Set<string>();
		for (const [tag] of sanitizedHtml.matchAll(IMG_TAG_RE)) {
			if (!isTrackingPixelTag(tag)) continue;
			pixelCount += 1;
			const host = remoteSrcHost(tag);
			if (host) hosts.add(host);
		}
		if (pixelCount === 0) return EMPTY_TRACKER_DETECTION;
		return { pixelCount, trackerHosts: [...hosts].sort() };
	} catch {
		return EMPTY_TRACKER_DETECTION;
	}
}

/**
 * Remove probable tracking-pixel <img> tags from sanitized message HTML so
 * "Show images" can load real content while pixels stay stripped.
 * Fails soft: any unexpected error returns the input unchanged.
 */
export function stripTrackerPixels(sanitizedHtml: string): string {
	try {
		return sanitizedHtml.replace(IMG_TAG_RE, (tag) =>
			isTrackingPixelTag(tag) ? '' : tag
		);
	} catch {
		return sanitizedHtml;
	}
}
