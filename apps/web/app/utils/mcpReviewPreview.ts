/**
 * The document an AI client's send previews in its approval card: the HTML
 * part as it goes out, under the reader's defences for mail it did not write.
 * The client wrote it, so it is treated like received mail: the shared Postbox
 * sanitizer (which drops scripts, `<style>`, `<meta>` refreshes and forms) and
 * the reader's no-network policy, so neither a remote image nor a font loads
 * while the owner looks. The card frames it with `sandbox=""`.
 *
 * The preview keeps inline styles, so text the sender made tiny or the colour
 * of the page looks that way here too. The card lists every link's real target
 * beside it, because a preview shows a link's text, not where it goes.
 *
 * Nothing in the preview can navigate: `sandbox=""` and the CSP still let a
 * click follow a link inside the frame, which would reach the sender's server
 * before the owner approved anything. So the preview's allowlist keeps no
 * `href` (the shared one allows no other navigating attribute), and the
 * anchor keeps its look through `data-owlat-link`. `form-action 'none'` is a
 * second guard; browsers never shipped a CSP directive for link navigation.
 */

import sanitizeHtml from 'sanitize-html';
import { POSTBOX_SANITIZE_CONFIG } from '@owlat/shared/postboxSanitize';
import { buildBaseStyle } from '~/utils/postboxBaseStyle';
import { POSTBOX_SRCDOC_HEAD } from '~/utils/postboxBodyPlaceholder';

const PREVIEW_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none';">`;

/** A link without `href` loses the browser's link underline; this puts it back. */
const LINK_STYLE = '<style>a[data-owlat-link]{text-decoration:underline;cursor:default;}</style>';

const PREVIEW_SANITIZE_CONFIG: sanitizeHtml.IOptions = {
	...POSTBOX_SANITIZE_CONFIG,
	allowedAttributes: {
		...POSTBOX_SANITIZE_CONFIG.allowedAttributes,
		a: ['title', 'name', 'data-owlat-link'],
	},
	transformTags: {
		a: (tagName, attribs) => ({
			tagName,
			attribs: 'href' in attribs ? { ...attribs, 'data-owlat-link': '' } : attribs,
		}),
	},
};

export function mcpReviewPreviewSrcdoc(html: string): string {
	return `${POSTBOX_SRCDOC_HEAD}${PREVIEW_CSP}${buildBaseStyle('light')}${LINK_STYLE}</head><body>${sanitizeHtml(html, PREVIEW_SANITIZE_CONFIG)}</body></html>`;
}
