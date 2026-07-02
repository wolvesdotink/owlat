/**
 * Heuristic split of an email body into "fresh" content vs. the quoted reply
 * chain. Pure string logic (no DOM, no dependencies) so it runs unchanged in
 * the browser (Postbox composer) AND on the Convex server (voice-profile
 * sampling, which must strip quoted originals out of the user's SENT bodies
 * before learning their writing voice).
 *
 * Returns { fresh, quoted } slices of the input HTML / text. If no quote
 * boundary is detected, `quoted` is empty and `hasQuote` is false.
 *
 * Heuristics (in order):
 *   1. Gmail's `<div class="gmail_quote">` wrapper
 *   2. Outlook's `_____` separator
 *   3. Generic `<blockquote>` blocks (Apple Mail, Outlook web)
 *   4. "On <date>, <name> wrote:" attribution lines (EN / DE / FR)
 *   5. Plain-text `> ` quote lines (text mode only)
 */

export interface QuotedSplitResult {
	fresh: string;
	quoted: string;
	hasQuote: boolean;
}

export const QUOTE_ATTRIBUTION_PATTERNS = [
	/On\s+\w+,?\s+(?:[A-Z][a-z]+\s+\d{1,2}|\d{1,2}\s+[A-Z][a-z]+).*?wrote:/,
	/^Am\s+\d{1,2}\.\d{1,2}\.\d{2,4}.*?schrieb\s/,
	/^Le\s+\d{1,2}.*?écrit\s*:/,
	/^On\s+\d{1,2}\/\d{1,2}\/\d{2,4}.*?wrote:/,
];

export function splitQuotedHtml(html: string): QuotedSplitResult {
	if (!html) return { fresh: '', quoted: '', hasQuote: false };

	// 1. Gmail wrapper
	const gmailIdx = html.search(/<div[^>]*class=["'][^"']*gmail_quote[^"']*["']/i);
	if (gmailIdx > 0) {
		return {
			fresh: html.slice(0, gmailIdx),
			quoted: html.slice(gmailIdx),
			hasQuote: true,
		};
	}

	// 2. Outlook _____ separator (often inside <hr> or as text)
	const outlookSep = html.search(/<(?:hr|div)[^>]*>(?:\s|&nbsp;)*_{4,}|_{5,}/i);
	if (outlookSep > 0) {
		return {
			fresh: html.slice(0, outlookSep),
			quoted: html.slice(outlookSep),
			hasQuote: true,
		};
	}

	// 3. First top-level <blockquote>. Only treat as quote boundary if
	//    there's content BEFORE it — replying to a thread leaves at least
	//    one paragraph at the top.
	const blockquoteIdx = html.search(/<blockquote/i);
	if (blockquoteIdx > 0) {
		const before = html.slice(0, blockquoteIdx);
		const stripped = before.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim();
		if (stripped.length > 0) {
			return {
				fresh: before,
				quoted: html.slice(blockquoteIdx),
				hasQuote: true,
			};
		}
	}

	// 4. Attribution line in plain-ish HTML
	for (const pattern of QUOTE_ATTRIBUTION_PATTERNS) {
		const match = html.match(pattern);
		if (match && match.index != null && match.index > 0) {
			return {
				fresh: html.slice(0, match.index),
				quoted: html.slice(match.index),
				hasQuote: true,
			};
		}
	}

	return { fresh: html, quoted: '', hasQuote: false };
}

export function splitQuotedText(text: string): QuotedSplitResult {
	if (!text) return { fresh: '', quoted: '', hasQuote: false };

	const lines = text.split('\n');
	let firstQuoteIdx = -1;

	// Attribution line or Outlook _____ separator
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		for (const pattern of QUOTE_ATTRIBUTION_PATTERNS) {
			if (pattern.test(line)) {
				firstQuoteIdx = i;
				break;
			}
		}
		if (firstQuoteIdx >= 0) break;

		if (/^_{4,}$/.test(line.trim())) {
			firstQuoteIdx = i;
			break;
		}
	}

	// Or a run of `> ` quote lines
	if (firstQuoteIdx < 0) {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? '';
			if (line.trim().startsWith('>') && i > 0) {
				firstQuoteIdx = i;
				break;
			}
		}
	}

	if (firstQuoteIdx < 0) {
		return { fresh: text, quoted: '', hasQuote: false };
	}

	return {
		fresh: lines.slice(0, firstQuoteIdx).join('\n'),
		quoted: lines.slice(firstQuoteIdx).join('\n'),
		hasQuote: true,
	};
}
