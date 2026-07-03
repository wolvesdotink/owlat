/**
 * Security: HTML and CSS sanitization utilities for email rendering.
 *
 * These functions prevent injection attacks in rendered email output:
 * - HTML content escaping (XSS prevention)
 * - HTML attribute escaping
 * - CSS injection prevention
 * - URL validation and escaping
 * - Raw HTML sanitization
 */

// The canonical escapeHtml lives in @owlat/shared/html (one definition for the
// whole monorepo). Re-exported so renderer call sites keep importing it from
// './sanitize'. escapeAttr/escapeCssUrl stay local (renderer-specific).
import { escapeHtml } from '@owlat/shared/html';
export { escapeHtml };

/**
 * Escape a value for use inside an HTML attribute (double-quoted).
 * Escapes &, <, >, " and '.
 *
 * Nullish input is coerced to '' so applying this to an optional field that is
 * absent at runtime does not throw (mirrors the pre-escaping behaviour where an
 * absent field interpolated to an empty/harmless value).
 */
export const escapeAttr = (str: string | undefined | null): string => {
	return escapeHtml(str ?? '');
};

/**
 * Escape a value for interpolation into a CSS style value (inside a
 * double-quoted `style="…"` attribute) or a VML color attribute
 * (`fillcolor="…"`, `strokecolor="…"`, `<v:fill color="…">`).
 *
 * Colour / font-family / border / width / background fields are attacker- or
 * template-controlled and were previously interpolated raw, so a `"` closed the
 * attribute and injected markup into outbound email HTML and the public
 * View-in-Browser archive (stored XSS). Escaping the HTML metacharacters
 * neutralises the breakout while leaving benign values (`#fff`, `rgb(0,0,0)`,
 * `1px solid #ccc`, `Arial, sans-serif`, `600px`, `100%`) rendered identically —
 * browsers decode entities inside attribute values before the CSS/VML parser
 * sees them. This mirrors the escaping the AMP path already applies.
 *
 * Nullish input is coerced to '' so applying this to an optional colour/font/
 * width field that is absent at runtime does not throw. Before escaping, an
 * absent field interpolated to a harmless `undefined`/empty literal; coercing
 * here preserves that render-does-not-throw guarantee for the many optional
 * style fields across the hand-built blocks (text `textColor`, list/menu
 * colours, …).
 */
export const escapeCss = (value: string | undefined | null): string => {
	return escapeHtml(value ?? '');
};

/**
 * Escape a value for use inside a CSS url() function.
 * Prevents breakout via ') or other CSS injection.
 */
export const escapeCssUrl = (url: string): string => {
	return url.replace(/[\\'"()]/g, (ch) => `\\${ch}`);
};

/**
 * Validate and sanitize a URL for use in href/src attributes.
 * Returns the URL if safe, empty string otherwise.
 * Blocks javascript:, data:, vbscript: protocols.
 */
export const sanitizeUrl = (url: string): string => {
	if (!url) return '';
	const trimmed = url.trim();
	// Block dangerous protocols
	const lower = trimmed.toLowerCase().replace(/[\s\p{Cc}]/gu, '');
	if (
		lower.startsWith('javascript:') ||
		lower.startsWith('vbscript:') ||
		lower.startsWith('data:')
	) {
		return '';
	}
	return trimmed;
};

/**
 * Validate that a URL uses https: protocol (for font imports, external resources).
 */
export const isHttpsUrl = (url: string): boolean => {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:';
	} catch {
		return false;
	}
};

/**
 * Sanitize custom CSS to prevent injection attacks.
 * Strips:
 * - </style> sequences (break out of style block)
 * - @import rules (external stylesheet loading)
 * - expression() (IE JS execution)
 * - -moz-binding (Firefox XBL)
 * - behavior: (IE HTC)
 * - url() with non-https external domains (data exfiltration)
 *
 * Preserves @inline and @head-only annotations.
 */
export const sanitizeCss = (css: string): string => {
	let result = css;

	// Strip </style> tag sequences (prevents breaking out of <style> block)
	result = result.replace(/<\/?style[^>]*>/gi, '');

	// Strip @import rules
	result = result.replace(/@import\s+[^;]+;?/gi, '');

	// Strip expression() (IE JS execution)
	result = result.replace(/expression\s*\([^)]*\)/gi, '');

	// Strip -moz-binding (Firefox XBL)
	result = result.replace(/-moz-binding\s*:[^;]+;?/gi, '');

	// Strip behavior: (IE HTC)
	result = result.replace(/behavior\s*:[^;]+;?/gi, '');

	// Strip url() with dangerous protocols (javascript:, data:, vbscript:)
	result = result.replace(/url\s*\(\s*(['"]?)\s*(?:javascript|data|vbscript)\s*:/gi, 'url($1about:');

	return result;
};

/**
 * Sanitize raw HTML blocks for embedding inside rendered emails.
 *
 * Backed by `sanitize-html` (HTML5-aware parser). Regex-based stripping
 * (the previous implementation) is fundamentally unsafe — nested
 * concatenation like `<scr<script>ipt>` survives a single pass, and
 * mutation-XSS via HTML5 parser quirks (comments, CDATA, foreign-content
 * switching) can smuggle scripts past a regex allowlist. We rely on a
 * real parser instead.
 *
 * The allowlist is intentionally narrower than the Postbox sanitizer
 * because these blocks are concatenated into *outbound* email HTML, where
 * we want a small, email-client-safe surface (no <form>, no <style>, no
 * <iframe>, no <svg>, no event handlers, no data:/javascript:/vbscript:
 * URLs).
 */
import sanitizeHtmlLib from 'sanitize-html';
import type { IOptions } from 'sanitize-html';

const RAW_HTML_SANITIZE_CONFIG: IOptions = {
	allowedTags: [
		'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
		'p', 'br', 'hr',
		'span', 'div', 'section', 'article', 'header', 'footer',
		'b', 'i', 'u', 'em', 'strong', 'small', 'sub', 'sup', 'mark',
		'a', 'ul', 'ol', 'li',
		'blockquote', 'pre', 'code',
		'figure', 'figcaption',
		'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
		'img', 'picture', 'source',
	],
	disallowedTagsMode: 'discard',
	allowedAttributes: {
		a: ['href', 'title', 'name', 'target', 'rel'],
		img: ['src', 'srcset', 'alt', 'width', 'height', 'loading'],
		picture: [],
		source: ['srcset', 'media', 'type'],
		td: ['colspan', 'rowspan', 'align', 'valign', 'bgcolor', 'width', 'height'],
		th: ['colspan', 'rowspan', 'align', 'valign', 'bgcolor', 'width', 'height'],
		table: ['width', 'cellspacing', 'cellpadding', 'border', 'align', 'bgcolor'],
		tr: ['align', 'valign', 'bgcolor'],
		'*': ['style', 'class', 'id', 'lang', 'dir'],
	},
	allowedSchemes: ['http', 'https', 'mailto', 'tel'],
	allowedSchemesByTag: {
		img: ['http', 'https', 'cid'],
		source: ['http', 'https', 'cid'],
	},
	allowedSchemesAppliedToAttributes: ['href', 'src', 'srcset'],
	allowProtocolRelative: false,
	// CSS allowlist: a thin, email-safe subset. Anything else is discarded
	// by sanitize-html silently. We intentionally do not allow position,
	// behavior, expression, -moz-binding, or url() values.
	allowedStyles: {
		'*': {
			color: [/^.+$/],
			'background-color': [/^.+$/],
			'font-size': [/^[\d.]+(px|pt|em|rem|%)$/i],
			'font-family': [/^[A-Za-z0-9 ,"'\-_]+$/],
			'font-weight': [/^(normal|bold|bolder|lighter|[1-9]00)$/i],
			'font-style': [/^(normal|italic|oblique)$/i],
			'text-align': [/^(left|right|center|justify|start|end)$/i],
			'text-decoration': [/^(none|underline|overline|line-through)( \w+)*$/i],
			'line-height': [/^[\d.]+(px|pt|em|rem|%)?$/i],
			padding: [/^[\d.\s\-a-z%]+$/i],
			margin: [/^[\d.\s\-a-z%]+$/i],
			border: [/^[\d.\s\-a-z#%(),]+$/i],
			'border-radius': [/^[\d.\s\-a-z%]+$/i],
			width: [/^[\d.\-a-z%]+$/i],
			height: [/^[\d.\-a-z%]+$/i],
			'max-width': [/^[\d.\-a-z%]+$/i],
		},
	},
	nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
};

export const sanitizeRawHtml = (html: string): string => {
	if (!html) return '';
	return sanitizeHtmlLib(html, RAW_HTML_SANITIZE_CONFIG);
};

/**
 * Escape a value for safe interpolation into a JSON string.
 * Handles characters that could break JSON.parse() or inject content.
 */
export const escapeJsonValue = (str: string): string => {
	return str
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t');
};
