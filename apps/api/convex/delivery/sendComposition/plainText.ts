/**
 * Send composition (module) — plain-text alternative leaf.
 *
 * Derives the `text/plain` alternative part from the composer's HTML body.
 *
 * Why this lives in the composer and not the MTA: the MTA's `stripHtml`
 * fallback runs over the *tracked* HTML — the html the worker hands the
 * provider after `transformHtml` has injected the open-tracking pixel and
 * rewritten every link into a `/t/c/...` redirect. Stripping that produces a
 * plain part whose links are opaque tracking redirects (and is one regex tweak
 * away from leaking the pixel URL). Building the text part HERE, from the
 * *untracked* personalized HTML the composer returns, gives a clean RFC 2046
 * §5.1.4 alternative whose content matches the HTML the recipient sees, with no
 * tracking-pixel or redirect-URL contamination.
 *
 * Runs in V8 (no Node-only APIs) — pure string transforms, no DOM library.
 */

/**
 * Convert an HTML body to a readable plain-text alternative. Block-level tags
 * become newlines, inline tags are dropped, common entities are decoded. The
 * input is the composer's untracked HTML, so no tracking pixel `<img>` or
 * `/t/c/` redirect link is present to leak.
 */
export function htmlToPlainText(html: string): string {
	return html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n\n')
		.replace(/<\/div>/gi, '\n')
		.replace(/<\/h[1-6]>/gi, '\n\n')
		.replace(/<\/li>/gi, '\n')
		.replace(/<\/tr>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#039;/gi, "'")
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
