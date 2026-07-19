/**
 * Tiny, dependency-free HTML scanning helpers shared by the link and
 * accessibility analyzers. This deliberately does NOT build a DOM: a
 * deliverability linter only needs to find tags and read a few attributes, and a
 * regex scan is deterministic, allocation-cheap, and safe to run on the untrusted
 * body of an email inside a synchronous send gate. The scanners are bounded — an
 * adversarial body cannot make them do super-linear work — because each regex is
 * linear and anchored to a tag opener.
 */

/** One parsed HTML element opener: its lowercased tag name and raw attributes. */
export interface HtmlTag {
	readonly name: string;
	readonly attributes: Readonly<Record<string, string>>;
}

/** One `<a>…</a>` element: its raw (undecoded) attribute string and inner HTML. */
export interface HtmlAnchor {
	readonly attributes: string;
	readonly inner: string;
}

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/** Decode the small set of HTML entities that matter for text comparisons. */
function decodeEntities(value: string): string {
	return value
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&nbsp;/gi, ' ');
}

function parseAttributes(raw: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (const match of raw.matchAll(ATTR_RE)) {
		const name = match[1]?.toLowerCase();
		if (!name) continue;
		let value = match[2] ?? '';
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		// First occurrence wins, matching how browsers treat duplicate attributes.
		if (!(name in attributes)) attributes[name] = decodeEntities(value);
	}
	return attributes;
}

/** Every element opener in `html`, in document order. Self-closing tags included. */
export function scanTags(html: string): HtmlTag[] {
	const tags: HtmlTag[] = [];
	for (const match of html.matchAll(TAG_RE)) {
		const name = match[1]?.toLowerCase();
		if (!name) continue;
		tags.push({ name, attributes: parseAttributes(match[2] ?? '') });
	}
	return tags;
}

/** All `<img>` element openers. */
export function scanImages(html: string): HtmlTag[] {
	return scanTags(html).filter((tag) => tag.name === 'img');
}

/**
 * Every `<a>…</a>` element in document order, exposing its raw attribute string
 * and inner HTML. Callers decide what to read — the link auditor parses the
 * `href` out of `attributes`, the accessibility auditor measures `inner` — so the
 * one anchor tokenizer lives here rather than being re-implemented per analyzer.
 */
export function scanAnchors(html: string): HtmlAnchor[] {
	const anchors: HtmlAnchor[] = [];
	for (const match of html.matchAll(ANCHOR_RE)) {
		anchors.push({ attributes: match[1] ?? '', inner: match[2] ?? '' });
	}
	return anchors;
}

/** Strip tags and collapse whitespace so text content can be measured/compared. */
export function textContent(html: string): string {
	return decodeEntities(html.replace(/<[^>]*>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim();
}
