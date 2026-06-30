/**
 * Shared sanitize-html configuration for Postbox HTML.
 *
 * Used at two boundaries:
 *   - Rendering received email bodies in `PostboxMessageBody.vue`. The
 *     iframe sandbox + inline CSP remain the load-bearing defenses;
 *     sanitization is defense-in-depth that closes residual privacy
 *     leaks (CSS exfiltration, meta-refresh, base href, srcset).
 *   - Saving user-authored signatures (`mailSignatures.ts`). A signature
 *     ships inside the recipient's HTML body without an iframe, so the
 *     allowlist is the *only* defense at that boundary.
 *
 * Both consumers import sanitize-html separately (and call it directly).
 * This module is just the config object so the policy stays in lock-step.
 */

import type { IOptions } from 'sanitize-html';

/** Subset of CSS properties safe to inline in email/signature HTML. */
const STYLE_PROPERTY_PATTERNS: Record<string, RegExp[]> = {
	color: [/^.+$/],
	'background-color': [/^.+$/],
	background: [/^(?!.*expression\().+$/i],
	// `data:` URIs are intentionally NOT allowed here: sanitize-html has no
	// length cap on style values, so a signature could embed a multi-MB
	// `data:image/png;base64,...` and balloon outbound message size. `cid:`
	// stays so users can reference inline attachments by content-id.
	'background-image': [/^url\(\s*['"]?(https?:|cid:).+/i],
	'background-position': [/^.+$/],
	'background-repeat': [/^(repeat|no-repeat|repeat-x|repeat-y|space|round)$/i],
	'background-size': [/^.+$/],
	'font-size': [/^[\d.]+(px|pt|em|rem|%)$/i],
	'font-family': [/^[A-Za-z0-9 ,"'\-_]+$/],
	'font-weight': [/^(normal|bold|bolder|lighter|[1-9]00)$/i],
	'font-style': [/^(normal|italic|oblique)$/i],
	'text-align': [/^(left|right|center|justify|start|end)$/i],
	'text-decoration': [/^(none|underline|overline|line-through)( \w+)*$/i],
	'line-height': [/^[\d.]+(px|pt|em|rem|%)?$/i],
	padding: [/^[\d.\s\-a-z%]+$/i],
	'padding-top': [/^[\d.\-a-z%]+$/i],
	'padding-right': [/^[\d.\-a-z%]+$/i],
	'padding-bottom': [/^[\d.\-a-z%]+$/i],
	'padding-left': [/^[\d.\-a-z%]+$/i],
	margin: [/^[\d.\s\-a-z%]+$/i],
	'margin-top': [/^[\d.\-a-z%]+$/i],
	'margin-right': [/^[\d.\-a-z%]+$/i],
	'margin-bottom': [/^[\d.\-a-z%]+$/i],
	'margin-left': [/^[\d.\-a-z%]+$/i],
	border: [/^[\d.\s\-a-z#%(),]+$/i],
	'border-color': [/^.+$/],
	'border-style': [/^(none|solid|dashed|dotted|double)$/i],
	'border-width': [/^[\d.\s\-a-z%]+$/i],
	'border-radius': [/^[\d.\s\-a-z%]+$/i],
	width: [/^[\d.\-a-z%]+$/i],
	height: [/^[\d.\-a-z%]+$/i],
	'max-width': [/^[\d.\-a-z%]+$/i],
	'min-width': [/^[\d.\-a-z%]+$/i],
	'max-height': [/^[\d.\-a-z%]+$/i],
	display: [/^(inline|block|inline-block|none|table|table-row|table-cell)$/i],
	'vertical-align': [/^(top|middle|bottom|baseline)$/i],
};

export const POSTBOX_SANITIZE_CONFIG: IOptions = {
	allowedTags: [
		'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
		'p', 'br', 'hr',
		'span', 'div', 'section', 'article', 'header', 'footer',
		'b', 'i', 'u', 'em', 'strong', 'small', 'sub', 'sup', 'mark',
		'a', 'ul', 'ol', 'li',
		'blockquote', 'pre', 'code',
		'figure', 'figcaption',
		'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
		'img', 'picture',
	],
	disallowedTagsMode: 'discard',
	allowedAttributes: {
		a: ['href', 'title', 'name'],
		img: ['src', 'srcset', 'alt', 'width', 'height', 'loading'],
		td: ['colspan', 'rowspan', 'align', 'valign', 'bgcolor', 'width', 'height'],
		th: ['colspan', 'rowspan', 'align', 'valign', 'bgcolor', 'width', 'height'],
		table: ['width', 'cellspacing', 'cellpadding', 'border', 'align', 'bgcolor'],
		tr: ['align', 'valign', 'bgcolor'],
		'*': ['style', 'class'],
	},
	// `cid:` and `data:` permitted on images so inline attachments and
	// tracking-pixel substitutes render; explicitly excluded from <a href>.
	allowedSchemes: ['http', 'https', 'mailto', 'tel'],
	allowedSchemesByTag: {
		img: ['http', 'https', 'cid', 'data'],
		picture: ['http', 'https', 'cid', 'data'],
	},
	allowedSchemesAppliedToAttributes: ['href', 'src', 'srcset'],
	allowProtocolRelative: false,
	allowedStyles: { '*': STYLE_PROPERTY_PATTERNS },
	// Defense-in-depth: kill `<base>` and `<meta>` (incl. refresh) even
	// though they're already absent from allowedTags — keeps intent
	// explicit for future maintainers reading this config.
	nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
	// Don't escape entities inside text — sanitize-html's default behaviour
	// of replacing `&` with `&amp;` would corrupt URL-encoded characters
	// in legitimate <a href> values.
	parser: { decodeEntities: true },
};
