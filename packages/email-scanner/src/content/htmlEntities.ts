/**
 * HTML entity decoding shared across content scan rules.
 *
 * Both the plain-text stripper (`index.ts` → `stripHtml`) and the phishing
 * URL normalizer (`phishingUrls.ts` → `normalizeHref`) need to collapse the
 * common named entities back to their literal characters so encoded payloads
 * (`paypal&#46;com` decoded by the URL normalizer, `&amp;` etc. in stripped
 * text) are scanned as the operator sees them. This is the single decoder
 * both reuse for that common core.
 */

/**
 * Decode the common named HTML entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`,
 * `&#39;`). Callers layer any extra decoding (numeric/hex references,
 * `&nbsp;` whitespace) on top as needed.
 */
export function decodeHtmlEntities(s: string): string {
	return s
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
}
