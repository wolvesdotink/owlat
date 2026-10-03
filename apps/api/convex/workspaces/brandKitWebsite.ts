/**
 * Reading a brand out of a website's HTML: the theme colour, logo candidates,
 * the site's name and the colours its CSS uses most. Pure and V8-safe; the
 * Node action in `brandKitImport.ts` fetches the page and its stylesheets and
 * hands the text here.
 *
 * The input is untrusted and capped by the caller. Every scan below is a
 * single left-to-right pass (`indexOf` loops and regexes without nested or
 * overlapping quantifiers), so a hostile page costs time linear in its size.
 */

import { isBrandHexColor, readableTextColor } from '@owlat/shared/brandKit';

/** Where a logo candidate was found, best first. */
export type LogoCandidateSource = 'appleTouchIcon' | 'logoImage' | 'icon' | 'ogImage';

export interface LogoCandidate {
	url: string;
	source: LogoCandidateSource;
}

export interface WebsiteBrandSignals {
	themeColor: string | null;
	siteName: string | null;
	logoCandidates: LogoCandidate[];
	/** Stylesheet URLs the page links, in document order. */
	stylesheetUrls: string[];
	/** Inline `<style>` and `style=""` text, for colour counting. */
	inlineCss: string;
}

export interface BrandProposal {
	primaryColor: string | null;
	secondaryColor: string | null;
	textColor: string | null;
	backgroundColor: string | null;
	linkColor: string | null;
	swatches: string[];
	companyName: string | null;
	logoCandidates: LogoCandidate[];
}

const MAX_LOGO_CANDIDATES = 4;
const MAX_STYLESHEETS = 3;
const MAX_TAGS = 2000;
const MAX_SWATCHES = 6;

const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

/**
 * Attribute map of one start tag's source (`<link rel=… href=…>`). A hand
 * scanner rather than a regex: one pass, so a long run of name characters
 * cannot make it backtrack.
 */
export function parseAttributes(tag: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const end = tag.endsWith('>') ? tag.length - 1 : tag.length;
	// Skip `<name`.
	let i = 1;
	while (i < end && !isSpace(tag[i]!) && tag[i] !== '/') i++;
	while (i < end) {
		while (i < end && (isSpace(tag[i]!) || tag[i] === '/')) i++;
		const nameStart = i;
		while (i < end && !isSpace(tag[i]!) && tag[i] !== '=' && tag[i] !== '/') i++;
		const name = tag.slice(nameStart, i).toLowerCase();
		while (i < end && isSpace(tag[i]!)) i++;
		let value = '';
		if (tag[i] === '=') {
			i++;
			while (i < end && isSpace(tag[i]!)) i++;
			const quote = tag[i];
			if (quote === '"' || quote === "'") {
				const close = tag.indexOf(quote, i + 1);
				const stop = close === -1 || close > end ? end : close;
				value = tag.slice(i + 1, stop);
				i = stop + 1;
			} else {
				const valueStart = i;
				while (i < end && !isSpace(tag[i]!)) i++;
				value = tag.slice(valueStart, i);
			}
		}
		if (name && !(name in attrs)) attrs[name] = decodeEntities(value);
		if (i === nameStart) i++;
	}
	return attrs;
}

/** A numeric character reference's character, or the reference itself when it names none. */
function fromCodePoint(reference: string, code: number): string {
	const isScalar = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
	return Number.isInteger(code) && isScalar ? String.fromCodePoint(code) : reference;
}

function decodeEntities(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&nbsp;/g, ' ')
		.replace(/&#x([0-9a-f]{1,6});/gi, (ref, hex: string) => fromCodePoint(ref, parseInt(hex, 16)))
		.replace(/&#(\d{1,7});/g, (ref, dec: string) => fromCodePoint(ref, Number(dec)))
		.replace(/&amp;/g, '&');
}

/** Every start tag named `name` (lower case), up to a fixed count. */
function startTags(html: string, name: string): string[] {
	const tags: string[] = [];
	const lower = html.toLowerCase();
	const needle = `<${name}`;
	let from = 0;
	while (tags.length < MAX_TAGS) {
		const at = lower.indexOf(needle, from);
		if (at === -1) break;
		const after = lower[at + needle.length];
		const end = lower.indexOf('>', at);
		if (end === -1) break;
		if (after === undefined || /[\s/>]/.test(after)) tags.push(html.slice(at, end + 1));
		from = end + 1;
	}
	return tags;
}

/** The text between each `<name …>` and its `</name>`. */
function elementTexts(html: string, name: string): string[] {
	const texts: string[] = [];
	const lower = html.toLowerCase();
	let from = 0;
	while (texts.length < MAX_TAGS) {
		const open = lower.indexOf(`<${name}`, from);
		if (open === -1) break;
		const start = lower.indexOf('>', open);
		if (start === -1) break;
		const close = lower.indexOf(`</${name}`, start);
		if (close === -1) break;
		texts.push(html.slice(start + 1, close));
		from = close + name.length + 2;
	}
	return texts;
}

/** The values of `style="…"` attributes, up to a fixed count. */
function styleAttributeValues(html: string): string[] {
	const values: string[] = [];
	const lower = html.toLowerCase();
	let from = 0;
	while (values.length < MAX_TAGS) {
		const at = lower.indexOf('style="', from);
		if (at === -1) break;
		const close = lower.indexOf('"', at + 7);
		if (close === -1) break;
		values.push(html.slice(at + 7, close));
		from = close + 1;
	}
	return values;
}

/** `href` resolved against the page, kept only when it is http(s). */
export function resolveHttpUrl(href: string | undefined, base: string): string | null {
	if (!href) return null;
	try {
		const url = new URL(href.trim(), base);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
	} catch {
		return null;
	}
}

/** Read the brand signals out of a page's HTML. */
export function extractWebsiteSignals(html: string, pageUrl: string): WebsiteBrandSignals {
	const metas = startTags(html, 'meta').map(parseAttributes);
	const links = startTags(html, 'link').map(parseAttributes);
	const meta = (key: string) =>
		metas.find((m) => (m['name'] ?? m['property'])?.toLowerCase() === key)?.['content']?.trim();

	const themeColor = normalizeColor(meta('theme-color') ?? '');
	const title = elementTexts(html, 'title')[0];
	const siteName =
		meta('og:site_name') || (title ? decodeEntities(title).replace(/\s+/g, ' ').trim() : '');

	const candidates: LogoCandidate[] = [];
	const add = (href: string | undefined, source: LogoCandidateSource) => {
		const url = resolveHttpUrl(href, pageUrl);
		if (url && !candidates.some((c) => c.url === url)) candidates.push({ url, source });
	};
	const rels = (l: Record<string, string>) => (l['rel'] ?? '').toLowerCase().split(/\s+/);
	for (const l of links) if (rels(l).includes('apple-touch-icon')) add(l['href'], 'appleTouchIcon');
	for (const img of startTags(html, 'img').map(parseAttributes)) {
		const hint = `${img['class'] ?? ''} ${img['id'] ?? ''} ${img['alt'] ?? ''}`.toLowerCase();
		if (hint.includes('logo')) add(img['src'], 'logoImage');
	}
	for (const l of links) {
		const isIcon = rels(l).includes('icon');
		// A .ico cannot go in an email; an SVG or PNG icon can.
		if (isIcon && !/\.ico(\?|$)/i.test(l['href'] ?? '')) add(l['href'], 'icon');
	}
	add(meta('og:image'), 'ogImage');

	const stylesheetUrls = links
		.filter((l) => rels(l).includes('stylesheet'))
		.map((l) => resolveHttpUrl(l['href'], pageUrl))
		.filter((url): url is string => url !== null)
		.slice(0, MAX_STYLESHEETS);

	const inlineCss = elementTexts(html, 'style').join('\n');
	const styleAttrs = styleAttributeValues(html).join('\n');

	return {
		themeColor,
		siteName: siteName ? siteName.slice(0, 120) : null,
		logoCandidates: candidates.slice(0, MAX_LOGO_CANDIDATES),
		stylesheetUrls,
		inlineCss: `${inlineCss}\n${styleAttrs}`,
	};
}

/** `#rgb`, `#rrggbb` or `rgb(r, g, b)` as lower-case `#rrggbb`; `null` otherwise. */
export function normalizeColor(value: string): string | null {
	const raw = value.trim().toLowerCase();
	if (isBrandHexColor(raw)) {
		return raw.length === 4 ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}` : raw;
	}
	const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(raw);
	if (!rgb) return null;
	const channels = rgb.slice(1, 4).map(Number);
	if (channels.some((c) => c > 255)) return null;
	return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Colours in `css`, most used first, with how often each appears. */
export function countCssColors(css: string): Array<{ color: string; count: number }> {
	const counts = new Map<string, number>();
	const re = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(css)) !== null) {
		const color = normalizeColor(match[0]);
		if (color) counts.set(color, (counts.get(color) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([color, count]) => ({ color, count }))
		.sort((a, b) => b.count - a.count || a.color.localeCompare(b.color));
}

function channels(hex: string): [number, number, number] {
	return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** HSL saturation (0–1): greys and near-greys are low. */
function saturation(hex: string): number {
	const [r, g, b] = channels(hex);
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const lightness = (max + min) / 2;
	if (max === min) return 0;
	return (max - min) / (1 - Math.abs(2 * lightness - 1));
}

function lightness(hex: string): number {
	const [r, g, b] = channels(hex);
	return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

/** Colours far enough apart to be told apart as two swatches. */
function isDistinct(a: string, b: string): boolean {
	const [ar, ag, ab] = channels(a);
	const [br, bg, bb] = channels(b);
	return Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb) > 0.18;
}

/**
 * Turn the signals and the counted colours into a kit proposal. The theme
 * colour, when the site declares one, is the primary colour; otherwise the
 * most used saturated colour is. Text is the most used dark colour, the
 * background the most used near-white. Anything not found is `null`, and the
 * settings page keeps its current value for it.
 */
export function proposeBrandKit(
	signals: WebsiteBrandSignals,
	colors: Array<{ color: string; count: number }>
): BrandProposal {
	const vivid = colors.filter(
		(c) => saturation(c.color) >= 0.25 && lightness(c.color) > 0.12 && lightness(c.color) < 0.88
	);
	const themeIsVivid =
		signals.themeColor !== null &&
		saturation(signals.themeColor) >= 0.25 &&
		lightness(signals.themeColor) < 0.95;
	const primary = themeIsVivid ? signals.themeColor : (vivid[0]?.color ?? null);
	const others = vivid.map((c) => c.color).filter((c) => !primary || isDistinct(c, primary));
	const secondary = others[0] ?? null;
	const text =
		colors.find((c) => lightness(c.color) < 0.3 && saturation(c.color) < 0.35)?.color ?? null;
	const background = colors.find((c) => lightness(c.color) > 0.94)?.color ?? null;

	const taken = [primary, secondary, text, background].filter((c): c is string => c !== null);
	const swatches: string[] = [];
	for (const c of others.slice(1)) {
		if (swatches.length >= MAX_SWATCHES) break;
		if ([...taken, ...swatches].every((t) => isDistinct(c, t))) swatches.push(c);
	}

	return {
		primaryColor: primary,
		secondaryColor: secondary,
		textColor: text,
		backgroundColor: background,
		// A link in the primary colour, unless it would not read on the page.
		linkColor:
			primary && readableTextColor(primary) === '#ffffff' ? primary : (secondary ?? primary),
		swatches,
		companyName: signals.siteName,
		logoCandidates: signals.logoCandidates,
	};
}
