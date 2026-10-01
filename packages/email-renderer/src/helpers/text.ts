/**
 * Plaintext extraction helpers. Used by text/rawHtml/table block modules to
 * convert HTML fragments into the multipart text/plain body.
 */

import { htmlToPlainText } from '@owlat/shared/html';

/**
 * Text of an HTML fragment for the multipart text/plain body: the shared
 * {@link htmlToPlainText} pass with block breaks kept (it drops script and style,
 * decodes every entity once and stays linear on hostile input). Two plain-text
 * mail conventions sit on top of it: a list item reads as `  - item`, and a
 * line carries no trailing blanks.
 */
export const stripHtml = (html: string): string =>
	htmlToPlainText(html.replace(/<li>/gi, '  - '), { preserveBreaks: true })
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n');

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
