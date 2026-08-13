/**
 * Plaintext extraction helpers. Used by text/rawHtml/table block modules to
 * convert HTML fragments into the multipart text/plain body.
 */

/** Guard against out-of-range references — those stay verbatim rather than throw. */
const codePointOr = (fallback: string, code: number): string =>
	Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;

/** Decode `&#8217;` / `&#x2019;` numeric character references. */
const decodeNumericEntities = (text: string): string =>
	text
		.replace(/&#(\d+);/g, (match, digits: string) => codePointOr(match, Number(digits)))
		.replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => codePointOr(match, parseInt(hex, 16)));

/**
 * Strip HTML tags, decode common entities, and collapse whitespace.
 */
export const stripHtml = (html: string): string =>
	decodeNumericEntities(
		html
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/p>/gi, '\n\n')
			.replace(/<\/div>/gi, '\n')
			.replace(/<\/h[1-6]>/gi, '\n\n')
			.replace(/<li>/gi, '  - ')
			.replace(/<\/li>/gi, '\n')
			.replace(/<[^>]+>/g, '')
			.replace(/&nbsp;/gi, ' ')
			.replace(/&amp;/gi, '&')
			.replace(/&lt;/gi, '<')
			.replace(/&gt;/gi, '>')
			.replace(/&quot;/gi, '"')
			.replace(/&#39;/gi, "'")
	)
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

/**
 * Anchor with a double-quoted, single-quoted, or unquoted href. The label is
 * matched lazily across markup so `<a href="x"><strong>Buy</strong></a>` keeps
 * its visible text.
 */
const ANCHOR_RE = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a>/gi;

/**
 * Expand `<a href="X">Y</a>` to `Y (X)` so links survive plaintext output.
 * Bare anchors (no visible text or text equal to href) collapse to just the URL,
 * as do `mailto:`/`tel:` links whose label already IS the address.
 */
export const extractLinks = (html: string): string =>
	html.replace(ANCHOR_RE, (_full, dq?: string, sq?: string, bare?: string, label?: string) => {
		const url = (dq ?? sq ?? bare ?? '').trim();
		const cleanLabel = stripHtml(label ?? '');
		if (!url) return cleanLabel;
		if (!cleanLabel || cleanLabel === url) return url;
		// `mailto:hi@example.com` labelled "hi@example.com" reads as a duplicate.
		if (url === `mailto:${cleanLabel}` || url === `tel:${cleanLabel}`) return cleanLabel;
		return `${cleanLabel} (${url})`;
	});

/** Underline characters per heading level; `h3` and paragraphs get none. */
const HEADING_RULES: Record<string, string> = { h1: '=', h2: '-' };

/** Longest line in a multi-line heading, capped so the rule stays readable. */
const MAX_RULE_WIDTH = 72;

/**
 * Render a heading as setext-style underlined text (`Title` + `=====`), the
 * convention plain-text mail readers recognise as a section break. Levels
 * without a rule character are returned unchanged.
 */
export const underlineHeading = (text: string, level: string): string => {
	const rule = HEADING_RULES[level];
	if (!rule || !text) return text;
	const width = Math.min(MAX_RULE_WIDTH, Math.max(...text.split('\n').map((line) => line.length)));
	return `${text}\n${rule.repeat(width)}`;
};
