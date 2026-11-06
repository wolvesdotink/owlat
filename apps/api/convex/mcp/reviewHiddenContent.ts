/**
 * Whether a send's HTML part holds content some recipients may not see, for
 * the approval card (`review` in `mcp/actionReview.ts`). The card's preview
 * renders the HTML under the reader's sanitizer, which drops `<style>`: a line
 * the outgoing stylesheet shows only in dark mode, or only on a phone, stays
 * hidden there, and a recipient still sees it. When this finds such content,
 * the card points the owner at the full text, which keeps every line.
 *
 * This is no CSS engine, and errs towards flagging: an element counts when its
 * own inline style hides it, or when it carries a class that any rule of the
 * message's stylesheets hides, whatever that rule's media query or selector.
 *
 * Not a Convex function module.
 */

import sanitizeHtml from 'sanitize-html';

/** A length of zero: `0`, `0px`, `.0em`, `0.00%`. */
const ZERO_LENGTH_RE = /^[+-]?(?:0+\.?0*|\.0+)(?:[a-z]+|%)?$/;

/** Whether a declaration list (an inline style or a rule's body) hides what it applies to. */
function hides(declarations: string): boolean {
	for (const declaration of declarations.split(';')) {
		const colon = declaration.indexOf(':');
		if (colon === -1) continue;
		const property = declaration.slice(0, colon).trim().toLowerCase();
		const value = declaration
			.slice(colon + 1)
			.replace(/!\s*important/i, '')
			.trim()
			.toLowerCase();
		if (property === 'display' && value === 'none') return true;
		if (property === 'visibility' && (value === 'hidden' || value === 'collapse')) return true;
		if ((property === 'font-size' || property === 'max-height') && ZERO_LENGTH_RE.test(value)) {
			return true;
		}
		if (property === 'mso-hide' && value === 'all') return true;
	}
	return false;
}

/**
 * The text of every `<style>` element, found with a forward scan (a style
 * element's content is raw text that ends at the first `</style`).
 */
function styleSheets(html: string): string[] {
	const lower = html.toLowerCase();
	const sheets: string[] = [];
	let at = lower.indexOf('<style');
	while (at !== -1) {
		const open = lower.indexOf('>', at);
		if (open === -1) break;
		const close = lower.indexOf('</style', open);
		sheets.push(html.slice(open + 1, close === -1 ? html.length : close));
		if (close === -1) break;
		at = lower.indexOf('<style', close);
	}
	return sheets;
}

const CLASS_SELECTOR_RE = /\.(-?[_a-zA-Z][\w-]*)/g;

/** Classes named in the selector of any rule that hides. */
function hidingClasses(sheets: string[]): Set<string> {
	const classes = new Set<string>();
	for (const sheet of sheets) {
		// Each `}` ends a rule; within the piece before it, the selector runs
		// from the previous `{` (an at-rule's, if any) to the rule's own `{`.
		for (const piece of sheet.split('}')) {
			const body = piece.lastIndexOf('{');
			if (body === -1 || !hides(piece.slice(body + 1))) continue;
			const selector = piece.slice(piece.lastIndexOf('{', body - 1) + 1, body);
			for (const match of selector.matchAll(CLASS_SELECTOR_RE)) classes.add(match[1] as string);
		}
	}
	return classes;
}

export function hasHiddenContent(html: string): boolean {
	const toggled = hidingClasses(styleSheets(html));
	let found = false;
	// The sanitizer's parser reads attributes the way a browser tokenizes
	// them; its output is discarded.
	sanitizeHtml(html, {
		allowedTags: false,
		allowedAttributes: false,
		onOpenTag: (_name, attribs) => {
			if (found) return;
			const classes = (attribs['class'] ?? '').split(/\s+/);
			found =
				attribs['hidden'] !== undefined ||
				hides(attribs['style'] ?? '') ||
				classes.some((name) => toggled.has(name));
		},
	});
	return found;
}
