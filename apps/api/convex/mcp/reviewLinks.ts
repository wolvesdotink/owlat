/**
 * Every link of an outgoing send, with where it really goes, for the approval
 * card (`review` in `mcp/actionReview.ts`). The card's preview shows a link's
 * text as the recipient sees it; this list shows its target, and flags a link
 * whose text names one domain while it goes to another.
 *
 * Not a Convex function module.
 */

import sanitizeHtml from 'sanitize-html';
import { htmlToPlainText } from '@owlat/shared/html';
import { linkDestination } from '@owlat/shared/postboxLinkTransparency';

/** Which part of the message a link is in. */
export type ReviewLinkPart = 'html' | 'text' | 'amp';

export type ReviewLink = {
	part: ReviewLinkPart;
	/** The target exactly as it goes out. */
	href: string;
	/** The target's host, or null when it is not an http(s) URL. */
	host: string | null;
	/** What the recipient reads as the link (HTML parts only). */
	text?: string;
	/** The host the text shows, present only when it is not where the link goes. */
	shownHost?: string;
};

/**
 * A parse that keeps only links and text. The sanitizer's parser reads the
 * markup the way a browser tokenizes it, so a `>` inside a quoted attribute or
 * an unquoted `href` cannot hide a link from the list the way a regex over the
 * raw markup would let it. Its output carries no tag but `a` and `area`, with
 * attribute values escaped, which the token walk below can read safely. No
 * scheme filter: a `javascript:` or `data:` target is listed as what it is.
 * Script and style text never renders, so it is not part of a link's text.
 */
const LINKS_ONLY: sanitizeHtml.IOptions = {
	allowedTags: ['a', 'area'],
	allowedAttributes: { a: ['href'], area: ['href', 'alt'] },
	allowedSchemesAppliedToAttributes: [],
	disallowedTagsMode: 'discard',
	nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title'],
};

const TOKEN_RE = /<a(?: href="([^"]*)")?>|<\/a>|<area\b([^>]*)>/g;
const ATTR_RE = (name: string) => new RegExp(`\\b${name}="([^"]*)"`);

/** Undo the four escapes the sanitizer writes into attribute values (`&amp;` last). */
function unescapeAttr(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, '&');
}

function linkOf(part: ReviewLinkPart, href: string, text: string | undefined): ReviewLink {
	const { host, shownHost } = linkDestination(href, text ?? '');
	return {
		part,
		href,
		host,
		...(text !== undefined ? { text } : {}),
		...(shownHost ? { shownHost } : {}),
	};
}

/** The links of one HTML part, in document order. */
function htmlLinks(part: ReviewLinkPart, html: string): ReviewLink[] {
	const flat = sanitizeHtml(html, LINKS_ONLY);
	const links: ReviewLink[] = [];
	let open: { href: string; text: string } | null = null;
	let at = 0;
	const close = () => {
		if (open) links.push(linkOf(part, open.href, htmlToPlainText(open.text)));
		open = null;
	};
	for (const token of flat.matchAll(TOKEN_RE)) {
		if (open) open.text += flat.slice(at, token.index);
		at = token.index + token[0].length;
		if (token[0] === '</a>') {
			close();
		} else if (token[0].startsWith('<area')) {
			const href = ATTR_RE('href').exec(token[2] ?? '')?.[1];
			const alt = ATTR_RE('alt').exec(token[2] ?? '')?.[1];
			if (href !== undefined) {
				links.push(linkOf(part, unescapeAttr(href), alt ? unescapeAttr(alt) : ''));
			}
		} else {
			// A browser closes an open link when the next one starts.
			close();
			if (token[1] !== undefined) open = { href: unescapeAttr(token[1]), text: '' };
		}
	}
	if (open) {
		open.text += flat.slice(at);
		close();
	}
	return links;
}

/** A URL in plain text ends before whitespace and before punctuation that closes a sentence. */
const TEXT_URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}]+$/;

/** The URLs of the plain-text part, which mail clients make clickable. */
function textLinks(text: string): ReviewLink[] {
	return Array.from(text.matchAll(TEXT_URL_RE), (match) =>
		linkOf('text', match[0].replace(TRAILING_PUNCTUATION_RE, ''), undefined)
	);
}

/**
 * Every link in the rendered parts of a send, each listed once per part with
 * the same text. Read from the bodies the review digest covers, so the list
 * cannot disagree with what goes out.
 */
export function reviewLinks(rendered: { html: string; text: string; amp?: string }): ReviewLink[] {
	const all = [
		...htmlLinks('html', rendered.html),
		...textLinks(rendered.text),
		...(rendered.amp ? htmlLinks('amp', rendered.amp) : []),
	];
	const seen = new Set<string>();
	return all.filter((link) => {
		const key = JSON.stringify([link.part, link.href, link.text]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
