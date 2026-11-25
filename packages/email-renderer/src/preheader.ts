import { escapeHtml } from '@owlat/shared/html';

/**
 * The hidden preheader: the inbox preview line at the top of the body. Kept in
 * its own module with no renderer imports, so the send path can strip it from
 * the HTML it turns into a text part without loading the renderer.
 */

const TEXT_OPEN =
	'<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;mso-hide:all">';
const PADDING_OPEN =
	'<div style="display:none;max-height:0;overflow:hidden" aria-hidden="true"><span style="font:0px/0 Arial">';

/**
 * Hidden preheader text, padded with zero-width spaces so email clients do not
 * pull body text into the preview after it. Empty text renders nothing.
 */
export function getPreheaderHtml(text: string): string {
	if (!text) return '';
	// Zero-width spaces + non-breaking spaces to fill preview and prevent body text leaking
	const padding = '&#847; &zwnj; &nbsp; &#8199; &#65279; '.repeat(30);
	return `${TEXT_OPEN}${escapeHtml(text)}</div>${PADDING_OPEN}${padding}</span></div>`;
}

const PREHEADER_RE = new RegExp(
	`${escapeRegExp(TEXT_OPEN)}[^<]*</div>${escapeRegExp(PADDING_OPEN)}[^<]*</span></div>`
);

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * The HTML without the preheader {@link getPreheaderHtml} wrote, personalized
 * or not. A text part derived from the HTML must not open with the preview
 * line and its padding: the preheader is an inbox device of the HTML part only.
 */
export function stripPreheaderHtml(html: string): string {
	return html.replace(PREHEADER_RE, '');
}
