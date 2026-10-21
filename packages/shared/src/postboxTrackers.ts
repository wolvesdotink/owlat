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

import { escapeImgTextInForeignContent, replaceImgTags, scanStartTag } from './postboxImgTags';
import { TRACKER_HOST_PATTERNS } from './postboxTrackerHosts';

export interface TrackerDetection {
	/** Number of elements in the sanitized HTML that load a probable tracker. */
	pixelCount: number;
	/** Deduped, sorted hosts of the flagged resources (for the badge popover). */
	trackerHosts: readonly string[];
}

// The named references that can spell a URL's scheme or authority; anything
// else a URL could hide behind a named reference leaves it unparseable, and an
// unparseable remote reference is classified conservatively.
const NAMED_CHAR_REFS: Record<string, string> = {
	amp: '&',
	apos: "'",
	colon: ':',
	gt: '>',
	lt: '<',
	newline: '\n',
	period: '.',
	quot: '"',
	sol: '/',
	tab: '\t',
};

/** Decode character references in a raw attribute value read from a tag string. */
function decodeCharRefs(value: string): string {
	return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));?/gi, (ref, dec, hex, name) => {
		if (dec || hex) {
			const code = Number.parseInt(dec ?? hex, dec ? 10 : 16);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
		}
		return NAMED_CHAR_REFS[String(name).toLowerCase()] ?? ref;
	});
}

/**
 * Extract an attribute value from a single tag string, decoded. Read with the
 * tag tokenizer, so text inside another attribute's quoted value (or a
 * `data-src`) is never mistaken for it; the first of duplicates wins, as in
 * the browser.
 */
function attrValue(tag: string, name: string): string | null {
	let raw: string | null = null;
	scanStartTag(tag, 1, (attr, value) => {
		if (raw === null && attr === name) raw = value;
	});
	return raw === null ? null : decodeCharRefs(raw);
}

/**
 * The first `src=` anywhere in a tag's text, quoted or bare, decoded: how the
 * scanner read tags before it tokenized them. Only for an `<img` the tokenizer
 * did not read as a tag (see `replaceImgTags`), where the browser's reading is
 * not known, so any `src=` in the text may be the one that loads.
 */
function looseSrcValue(tag: string): string | null {
	const m = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
	const raw = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
	return raw == null ? null : decodeCharRefs(raw);
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

/**
 * A URL as the browser's URL parser sees it: leading and trailing C0 controls
 * and spaces stripped, and every tab and newline removed wherever it sits, so
 * `https:<TAB>//tracker.example/` is read as the fetch it becomes.
 */
function normalizeResourceUrl(url: string): string {
	// Index scans rather than an anchored regex, which is quadratic on a long
	// run of spaces that does not reach the end.
	let start = 0;
	let end = url.length;
	while (start < end && url.charCodeAt(start) <= 0x20) start++;
	while (end > start && url.charCodeAt(end - 1) <= 0x20) end--;
	return url.slice(start, end).replace(/[\t\n\r]/g, '');
}

/** True for `data:`/`cid:` references: they arrived with the message. */
export function isEmbeddedResourceUrl(url: string): boolean {
	return /^(data|cid):/i.test(normalizeResourceUrl(url));
}

/**
 * Host of a remote http(s) or protocol-relative URL, parsed the way the
 * browser parses it. Null for anything else: an embedded `data:`/`cid:`
 * reference, a relative path, another scheme, or a URL that does not parse.
 */
export function remoteResourceHost(url: string | null): string | null {
	if (url == null) return null;
	const base = 'https://owlat.invalid/';
	try {
		const parsed = new URL(normalizeResourceUrl(url), base);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
		if (parsed.href.startsWith(base)) return null;
		// One trailing root dot names the same host (`list-manage.com.`), so it
		// must not slip past the tracker suffix match.
		const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
		return host || null;
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

/** What an element's size and visibility say about every resource on it. */
export interface TrackingHints {
	/** Hidden (`display:none`) or declared 0/1px: whatever it loads is a beacon. */
	looksLikePixel: boolean;
}

/**
 * Read an element's hints once. The reader classifies every reference on an
 * element (thousands of CSS URLs, possibly) against the same hints, so they
 * must not be re-derived from the style per URL.
 */
export function elementTrackingHints(context: RemoteResourceContext): TrackingHints {
	if (/display\s*:\s*none/i.test(context.style)) return { looksLikePixel: true };
	const dims = [
		context.width,
		styleProp(context.style, 'width'),
		context.height,
		styleProp(context.style, 'height'),
	];
	// Pixel-sized: at least one declared 0/1px dimension and none larger.
	return { looksLikePixel: dims.some(isPixelSize) && !dims.some(isVisibleSize) };
}

/**
 * Classify one remote resource reference (an `<img>` src, one srcset
 * candidate, or a CSS background URL) by the element it sits on. Exported for
 * the reader's resource inventory, which covers every way a body loads one.
 */
export function isTrackingResource(url: string, hints: TrackingHints): boolean {
	// No remote fetch -> cannot track, regardless of size/visibility.
	if (isEmbeddedResourceUrl(url)) return false;
	const host = remoteResourceHost(url);
	// A reference that is neither embedded nor a readable http(s) URL is
	// treated as a tracker: its host cannot be checked against the list.
	if (!host) return true;
	return isKnownTrackerHost(host) || hints.looksLikePixel;
}

/** Classify one <img ...> tag string. Exported for tests. */
export function isTrackingPixelTag(tag: string): boolean {
	const src = attrValue(tag, 'src');
	if (!src) return false;
	return isTrackingResource(
		src,
		elementTrackingHints({
			width: attrValue(tag, 'width'),
			height: attrValue(tag, 'height'),
			style: attrValue(tag, 'style') ?? '',
		})
	);
}

/** True for a src that is set and is not an inline `data:`/`cid:` part. */
function isRemoteSrc(src: string | null): boolean {
	if (!src || normalizeResourceUrl(src) === '') return false;
	// Only inline parts are known not to phone home; anything else, however it
	// is spelled (`https:&#9;//…`, `//host/…`), is stripped.
	return !isEmbeddedResourceUrl(src);
}

/**
 * True when an <img ...> tag string has a remote src. A tag that was not
 * tokenized (see `replaceImgTags`) also counts when any `src=` in its text is
 * remote, as the earlier scanner read it.
 */
function isRemoteImgTag(tag: string, tokenized: boolean): boolean {
	return isRemoteSrc(attrValue(tag, 'src')) || (!tokenized && isRemoteSrc(looseSrcValue(tag)));
}

// A removal can join the text around it into a new tag (`<<img …>img …>`) or
// pair a quote differently, so an `<img` that sat inside a value becomes a
// tag; each round re-reads the previous round's output. Crafted input that
// keeps doing so past the last round has every `<img` left turned into text.
const MAX_STRIP_ROUNDS = 4;
const IMG_TAG_OPEN_RE = /<(?=img(?![\w]))/gi;

export interface RemoteImageStripResult {
	/** HTML with every remote-src <img> tag removed. */
	html: string;
	/** How many remote-image tags were removed (tracking pixels included). */
	strippedRemoteImages: number;
}

/**
 * Remove EVERY remote-src <img> tag from an HTML body — a 1×1 /
 * display:none / known-tracker pixel is just a remote image, so this covers
 * them all — while leaving inline `data:`/`cid:` images and non-image content
 * untouched.
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
		let out = html;
		let strippedRemoteImages = 0;
		for (let round = 0; round < MAX_STRIP_ROUNDS; round++) {
			let removed = 0;
			out = replaceImgTags(out, (tag, tokenized) => {
				if (!isRemoteImgTag(tag, tokenized)) return tag;
				removed += 1;
				return '';
			});
			strippedRemoteImages += removed;
			if (removed === 0) {
				return { html: escapeImgTextInForeignContent(out), strippedRemoteImages };
			}
		}
		return { html: out.replace(IMG_TAG_OPEN_RE, '&lt;'), strippedRemoteImages };
	} catch {
		return { html, strippedRemoteImages: 0 };
	}
}
