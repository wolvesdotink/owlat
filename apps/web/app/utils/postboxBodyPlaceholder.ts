/**
 * The saved copy of a message body (the offline read cache keeps the reader's
 * last sanitized srcdoc) doubles as an instant placeholder while the live body
 * is still loading. Pure string work, so it is unit-tested without the reader.
 */

import { buildComfortStyle, POSTBOX_COMFORT_STYLE_OPEN } from '~/utils/postboxBaseStyle';
import type { EmailHtmlKind, PostboxRenderScheme } from '~/utils/postboxDarkMode';
import type { MailTypography } from '~/utils/readingComfort';

/** Opening of every srcdoc PostboxMessageBody builds, CSP meta included. */
export const POSTBOX_SRCDOC_HEAD = '<!doctype html><html><head>';
/**
 * `upgrade-insecure-requests` fetches an `http:` image over https instead of
 * letting `img-src https:` refuse it: plenty of senders still write `http://`
 * into their markup, and those images stayed broken even for a trusted sender.
 * Nothing is ever fetched in cleartext.
 */
export const POSTBOX_BODY_META_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:; upgrade-insecure-requests;">`;

/**
 * Same policy with no network at all: remote images and fonts stay blocked.
 * A live body renders under it until the user consents to remote images, so
 * no spelling of a remote reference (a CSS background, a srcset candidate)
 * can load before that; the saved-copy placeholder uses it too.
 */
export const POSTBOX_BODY_META_CSP_NO_REMOTE = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;">`;

// Markers buildBaseStyle writes into the head: the dark scheme pins
// color-scheme, and "simple" mail gets a transparent canvas.
const DARK_MARKER = ':root{color-scheme:dark;}';
const SIMPLE_MARKER = 'html,body{background:transparent;}';

export interface PostboxBodyPlaceholder {
	srcdoc: string;
	scheme: PostboxRenderScheme;
	kind: EmailHtmlKind;
}

/**
 * Turn a saved srcdoc into a placeholder, or null when there is none.
 *
 * With `blockRemote` (the reader is online and a live body is on its way) the
 * CSP is swapped for one that loads nothing from the network. The saved copy
 * may have been rendered after "Show images" or "Load everything"; replaying
 * it as-is would fetch those images and tracking pixels again without the
 * user asking this time. A copy saved while images were blocked already
 * carries the no-network policy. A saved copy that starts with neither head is
 * not used at all, since its policy cannot be swapped reliably.
 *
 * The copy keeps the typography it was saved under, so its comfort block is
 * replaced with one for the reader's current `typography` (or added, for a copy
 * saved before the block existed: last in the head, it wins the cascade).
 */
export function postboxBodyPlaceholder(
	cachedSrcdoc: string | null,
	options: { blockRemote: boolean; typography: MailTypography }
): PostboxBodyPlaceholder | null {
	if (!cachedSrcdoc) return null;
	let srcdoc = cachedSrcdoc;
	if (options.blockRemote) {
		const head = POSTBOX_SRCDOC_HEAD + POSTBOX_BODY_META_CSP;
		const blockedHead = POSTBOX_SRCDOC_HEAD + POSTBOX_BODY_META_CSP_NO_REMOTE;
		if (cachedSrcdoc.startsWith(head)) {
			srcdoc = blockedHead + cachedSrcdoc.slice(head.length);
		} else if (!cachedSrcdoc.startsWith(blockedHead)) {
			return null;
		}
	}
	const headEnd = srcdoc.indexOf('</head>');
	const headPart = headEnd >= 0 ? srcdoc.slice(0, headEnd) : '';
	const kind: EmailHtmlKind = headPart.includes(SIMPLE_MARKER) ? 'simple' : 'designed';
	return {
		srcdoc: headEnd >= 0 ? withComfortStyle(srcdoc, headEnd, kind, options.typography) : srcdoc,
		scheme: headPart.includes(DARK_MARKER) ? 'dark' : 'light',
		kind,
	};
}

/** `srcdoc` with its head's comfort block set to `typography`. */
function withComfortStyle(
	srcdoc: string,
	headEnd: number,
	kind: EmailHtmlKind,
	typography: MailTypography
): string {
	const style = buildComfortStyle(kind, typography);
	const open = srcdoc.lastIndexOf(POSTBOX_COMFORT_STYLE_OPEN, headEnd);
	const close = open >= 0 ? srcdoc.indexOf('</style>', open) : -1;
	if (open >= 0 && close >= 0 && close < headEnd) {
		return srcdoc.slice(0, open) + style + srcdoc.slice(close + '</style>'.length);
	}
	return srcdoc.slice(0, headEnd) + style + srcdoc.slice(headEnd);
}
