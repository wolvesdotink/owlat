/**
 * Base <style> for the sandboxed iframe a received message renders in, per
 * color scheme and kind of mail.
 */

import {
	LIGHT_TEXT,
	POSTBOX_DARK_PALETTE,
	type EmailHtmlKind,
	type PostboxRenderScheme,
} from './postboxDarkMode';

/** The app's own UI font stack, so plain mail reads like the rest of Owlat. */
const FONT_STACK = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';

/**
 * Outlook ships its paragraph reset (`p.MsoNormal{margin:0;font-size:11pt}`)
 * in a <style> block, which sanitization drops. Without it every
 * `<p>&nbsp;</p>` spacer Outlook writes between lines picks up the default 1em
 * margins on both sides, and each line box is sized from our 15px body font
 * rather than Outlook's 11pt, so a short reply balloons into a wall of blank
 * space. Restoring the reset is faithful to how the sender saw it, so it
 * applies to designed mail too. The line height stays a little looser than
 * Outlook's own for reading comfort.
 */
const OUTLOOK_RESET_STYLE =
	'p.MsoNormal,li.MsoNormal,div.MsoNormal{margin:0;font-size:11pt;line-height:1.4;}';

/**
 * Reading-typography block for "simple" (mostly-text) mail: a comfortable
 * measure capped around 72ch and aligned with the message header (not
 * centered, which left the text floating in the middle of a wide reader), a
 * slightly larger base size, a roomier line-height, long URLs that wrap instead
 * of scrolling sideways, and no stray margin above the first or below the last
 * block. The background stays transparent so the body sits directly on the
 * message card instead of in a second box. "Designed" mail (marketing /
 * newsletter layouts) never receives this — its own layout stays untouched.
 *
 * `pre` wraps: a plain-text body arrives as a `<pre style="white-space:pre-wrap">`,
 * but the sanitizer allowlist has no `white-space`, so the inline style is
 * stripped and every plain-text message ran off the card on one line.
 */
function simpleMeasureStyle(quoteBorder: string, quoteText: string): string {
	return (
		'html,body{background:transparent;}' +
		'body{max-width:72ch;font-size:15px;line-height:1.6;overflow-wrap:break-word;}' +
		'pre{white-space:pre-wrap;}' +
		'body>:first-child{margin-top:0;}body>:last-child{margin-bottom:0;}' +
		`blockquote{margin:0.5em 0 0.5em 0.25em;padding-left:0.9em;border-left:2px solid ${quoteBorder};color:${quoteText};}`
	);
}

/**
 * Base <style> for the iframe head. "Designed" mail (the default `kind`) keeps
 * its own canvas on a white paper card and only gets the shared basics; "simple"
 * mail additionally gets the reading-measure block and a transparent canvas.
 */
export function buildBaseStyle(
	scheme: PostboxRenderScheme,
	kind: EmailHtmlKind = 'designed'
): string {
	const base = `font-family:${FONT_STACK};font-size:14px;line-height:1.55;margin:0;padding:0;`;
	if (scheme === 'dark') {
		return (
			'<style>:root{color-scheme:dark;}' +
			`html,body{${base}color:${POSTBOX_DARK_PALETTE.text};background:${POSTBOX_DARK_PALETTE.background};}` +
			'img{max-width:100%;height:auto;}' +
			`a{color:${POSTBOX_DARK_PALETTE.link};}` +
			`blockquote{border-color:${POSTBOX_DARK_PALETTE.mutedBorder};}` +
			OUTLOOK_RESET_STYLE +
			(kind === 'simple'
				? simpleMeasureStyle(POSTBOX_DARK_PALETTE.mutedBorder, POSTBOX_DARK_PALETTE.mutedText)
				: '') +
			'</style>'
		);
	}
	return (
		`<style>html,body{${base}color:${LIGHT_TEXT};}` +
		'img{max-width:100%;height:auto;}a{color:#0a6cdd;}' +
		OUTLOOK_RESET_STYLE +
		(kind === 'simple' ? simpleMeasureStyle('#d4d4d8', '#52525b') : '') +
		'</style>'
	);
}
