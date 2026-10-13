/**
 * Tracking-pixel classification for Postbox received mail (Apple-Mail-Privacy-
 * style transparency), plus the remote-image strip the agent pipeline uses.
 *
 * Pure functions that make no network call and never touch the sanitizer
 * allowlist. The reader's resource inventory (`apps/web/app/utils/
 * postboxRemoteResources.ts`) walks every way a sanitized body can load a
 * remote resource (an `<img>` src, each srcset candidate, a CSS background)
 * and classifies each one here. That inventory powers:
 *   - the "Images blocked — N tracking pixels detected" banner,
 *   - keeping pixels stripped when the user clicks "Show images"
 *     (with a separate "load everything" escalation),
 *   - the shield badge naming the tracker hosts.
 *
 * Heuristics (a remote http(s) resource is flagged when ANY holds for the
 * element it sits on):
 *   - declared 0/1px size via width/height attributes or inline style,
 *   - `display:none` in inline style,
 *   - its host matches a well-known open-tracker pattern
 *     (see `postboxTrackerHosts.ts`).
 *
 * `data:`/`cid:` resources are never flagged — they cannot phone home.
 */

import { TRACKER_HOST_PATTERNS } from './postboxTrackerHosts';

export interface TrackerDetection {
	/** Number of elements in the sanitized HTML that load a probable tracker. */
	pixelCount: number;
	/** Deduped, sorted hosts of the flagged resources (for the badge popover). */
	trackerHosts: readonly string[];
}

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

/** Host of a remote http(s) or protocol-relative URL, or null for data:/cid:/relative. */
export function remoteResourceHost(url: string | null): string | null {
	const trimmed = url?.trim();
	if (!trimmed || !/^(https?:)?\/\//i.test(trimmed)) return null;
	try {
		return new URL(trimmed, 'https://invalid.example').hostname.toLowerCase();
	} catch {
		return null;
	}
}

function isKnownTrackerHost(host: string): boolean {
	return TRACKER_HOST_PATTERNS.some((pattern) => host === pattern || host.endsWith(`.${pattern}`));
}

/** The element a remote resource is loaded for: its size and visibility hints. */
export interface RemoteResourceContext {
	width: string | null;
	height: string | null;
	style: string;
}

/**
 * Classify one remote resource reference (an `<img>` src, one srcset
 * candidate, or a CSS background URL) by the element it sits on. Exported for
 * the reader's resource inventory, which covers every way a body loads one.
 */
export function isTrackingResource(url: string, context: RemoteResourceContext): boolean {
	const host = remoteResourceHost(url);
	// No remote fetch -> cannot track, regardless of size/visibility.
	if (!host) return false;

	if (isKnownTrackerHost(host)) return true;

	if (/display\s*:\s*none/i.test(context.style)) return true;

	const widths = [context.width, styleProp(context.style, 'width')];
	const heights = [context.height, styleProp(context.style, 'height')];
	const dims = [...widths, ...heights];
	// Pixel-sized: at least one declared 0/1px dimension and none larger.
	return dims.some(isPixelSize) && !dims.some(isVisibleSize);
}

/** Classify one <img ...> tag string. Exported for tests. */
export function isTrackingPixelTag(tag: string): boolean {
	const src = attrValue(tag, 'src');
	if (!src) return false;
	return isTrackingResource(src, {
		width: attrValue(tag, 'width'),
		height: attrValue(tag, 'height'),
		style: attrValue(tag, 'style') ?? '',
	});
}

/** True when an <img ...> tag string has a REMOTE src (http/https/protocol-relative). */
function isRemoteImgTag(tag: string): boolean {
	const src = attrValue(tag, 'src');
	if (!src) return false;
	const trimmed = src.trim();
	// `data:`/`cid:`/relative sources never phone home; only absolute http(s)
	// and protocol-relative `//host/...` can resolve a remote resource.
	return /^https?:\/\//i.test(trimmed) || trimmed.startsWith('//');
}

export interface RemoteImageStripResult {
	/** HTML with every remote-src <img> tag removed. */
	html: string;
	/** How many remote-image tags were removed (tracking pixels included). */
	strippedRemoteImages: number;
}

/**
 * Remove EVERY remote-src <img> tag from an HTML body — the superset of
 * `stripTrackerPixels` (a 1×1 / display:none / known-tracker pixel is just a
 * remote image, so this covers them all) while leaving inline `data:`/`cid:`
 * images and non-image content untouched.
 *
 * This is the single privacy-strip primitive shared by:
 *   - the OUTBOUND auto-send reference monitor (so an unattended reply can't
 *     beacon), and
 *   - the INBOUND agent pipeline (so merely scanning/reading a message for
 *     context never resolves a remote pixel and leaks an open + IP to the
 *     sender — the AI reads every inbound, which would otherwise register an
 *     "open" on every message automatically).
 *
 * Pure string surgery — makes NO network call and never touches the sanitizer
 * allowlist. Fails soft: any unexpected error returns the input unchanged with
 * a zero count, so callers degrade to their prior behaviour.
 */
export function stripRemoteImages(html: string): RemoteImageStripResult {
	try {
		let strippedRemoteImages = 0;
		const out = html.replace(IMG_TAG_RE, (tag) => {
			if (!isRemoteImgTag(tag)) return tag;
			strippedRemoteImages += 1;
			return '';
		});
		return { html: out, strippedRemoteImages };
	} catch {
		return { html, strippedRemoteImages: 0 };
	}
}
