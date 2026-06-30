/**
 * Heuristic split of an email body into "fresh" content vs. quoted reply chain.
 *
 * Returns { fresh, quoted } slices of the input HTML / text. If we can't
 * detect a quote boundary, `quoted` is empty.
 *
 * Heuristics (in order):
 *   1. Gmail's `<div class="gmail_quote">` wrapper
 *   2. Generic `<blockquote>` blocks (Apple Mail, Outlook web)
 *   3. "On <date>, <name> wrote:" attribution lines
 *   4. Outlook's `_____` separator
 *   5. Plain-text `> ` quote lines (text mode only)
 */

import sanitizeHtml from 'sanitize-html';
import { POSTBOX_SANITIZE_CONFIG } from '@owlat/shared/postboxSanitize';
import { escapeHtml } from '@owlat/shared/html';

interface SplitResult {
	fresh: string;
	quoted: string;
	hasQuote: boolean;
}

interface QuoteSource {
	fromAddress: string;
	fromName?: string;
	toAddresses?: string[];
	subject?: string;
	receivedAt: number;
	htmlBodyInline?: string;
	textBodyInline?: string;
}

/**
 * The original body as HTML, falling back to a <pre>-wrapped text body.
 *
 * SECURITY: htmlBodyInline is attacker-controlled inbound email. The reader
 * renders it inside a sandboxed iframe, but the quote is embedded into the
 * composer's contenteditable (an `el.innerHTML =` sink in the app origin), so
 * it MUST be run through the same sanitize-html allowlist here or an
 * `<img onerror=…>` payload would execute on Reply/Forward (stored DOM-XSS).
 */
function originalAsHtml(msg: QuoteSource): string {
	if (msg.htmlBodyInline) return sanitizeHtml(msg.htmlBodyInline, POSTBOX_SANITIZE_CONFIG);
	if (msg.textBodyInline) {
		return `<pre style="white-space:pre-wrap;font-family:inherit;margin:0;">${escapeHtml(
			msg.textBodyInline
		)}</pre>`;
	}
	return '';
}

function formatSender(msg: QuoteSource): string {
	return msg.fromName
		? `${escapeHtml(msg.fromName)} &lt;${escapeHtml(msg.fromAddress)}&gt;`
		: escapeHtml(msg.fromAddress);
}

/**
 * A Gmail-style quoted reply body: blank space for the reply on top, then an
 * attribution line and the original wrapped in a quote block.
 */
export function buildQuotedReply(msg: QuoteSource): string {
	const attribution = `On ${new Date(msg.receivedAt).toLocaleString()}, ${formatSender(msg)} wrote:`;
	return (
		`<br><br><div class="gmail_quote"><div>${attribution}</div>` +
		`<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex;color:#555;">` +
		`${originalAsHtml(msg)}</blockquote></div>`
	);
}

/** A "Forwarded message" header block followed by the original body. */
export function buildForwardedBody(msg: QuoteSource): string {
	const to = (msg.toAddresses ?? []).map(escapeHtml).join(', ');
	const header =
		`---------- Forwarded message ----------<br>` +
		`From: ${formatSender(msg)}<br>` +
		`Date: ${new Date(msg.receivedAt).toLocaleString()}<br>` +
		`Subject: ${escapeHtml(msg.subject ?? '')}<br>` +
		(to ? `To: ${to}<br>` : '');
	return `<br><br><div class="gmail_quote">${header}<br>${originalAsHtml(msg)}</div>`;
}

const ATTRIBUTION_PATTERNS = [
	/On\s+\w+,?\s+(?:[A-Z][a-z]+\s+\d{1,2}|\d{1,2}\s+[A-Z][a-z]+).*?wrote:/,
	/^Am\s+\d{1,2}\.\d{1,2}\.\d{2,4}.*?schrieb\s/,
	/^Le\s+\d{1,2}.*?écrit\s*:/,
	/^On\s+\d{1,2}\/\d{1,2}\/\d{2,4}.*?wrote:/,
];

export function splitQuotedHtml(html: string): SplitResult {
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
	const outlookSep = html.search(
		/<(?:hr|div)[^>]*>(?:\s|&nbsp;)*_{4,}|_{5,}/i
	);
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
		// Look backwards: is there visible content before the blockquote?
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
	for (const pattern of ATTRIBUTION_PATTERNS) {
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

export function splitQuotedText(text: string): SplitResult {
	if (!text) return { fresh: '', quoted: '', hasQuote: false };

	const lines = text.split('\n');
	let firstQuoteIdx = -1;

	// Look for >5 attribution + > prefix lines
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		for (const pattern of ATTRIBUTION_PATTERNS) {
			if (pattern.test(line)) {
				firstQuoteIdx = i;
				break;
			}
		}
		if (firstQuoteIdx >= 0) break;

		// Outlook _____
		if (/^_{4,}$/.test(line.trim())) {
			firstQuoteIdx = i;
			break;
		}
	}

	// Or run of > lines
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
