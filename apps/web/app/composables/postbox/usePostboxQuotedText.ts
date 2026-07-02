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
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { POSTBOX_SANITIZE_CONFIG } from '@owlat/shared/postboxSanitize';
import { escapeHtml, escapeHtmlWithBreaks } from '@owlat/shared/html';
import type { ComposerSpec } from '~/composables/postbox/usePostboxComposerStack';

// The quote-boundary splitters are shared with the Convex server (voice-profile
// sampling strips quoted text from SENT bodies with the identical heuristics).
export { splitQuotedHtml, splitQuotedText } from '@owlat/shared/quotedText';

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

/** Minimal message shape needed to resolve and quote an original for reply. */
export interface ReplyQuoteTarget extends QuoteSource {
	_id: string;
	subject: string;
}

/**
 * Resolve the original body for quoting. Messages over ~64KB store their body
 * in blob storage with empty inline fields, so a reply/forward would quote an
 * empty original — fetch the full body in that case (the same source
 * PostboxMessageBody renders from). Falls back to the input on any error so
 * the composer always opens. Shared by the thread reader and the Reply Queue.
 */
export async function resolveBodyFields<T extends { _id: string } & QuoteSource>(
	t: T
): Promise<T> {
	if (t.htmlBodyInline || t.textBodyInline) return t;
	try {
		const data = await requireConvex().query(api.mail.mailbox.getMessageBody, {
			messageId: t._id as Id<'mailMessages'>,
		});
		if (!data) return t;
		let html = data.htmlInline ?? undefined;
		let text = data.textInline ?? undefined;
		if (!html && data.htmlUrl) html = await (await fetch(data.htmlUrl)).text();
		else if (!text && data.textUrl) text = await (await fetch(data.textUrl)).text();
		return { ...t, htmlBodyInline: html, textBodyInline: text };
	} catch {
		return t;
	}
}

/** "Re: " subject prefix guard — never stacks a second "Re:". */
export function replySubject(subject: string): string {
	return subject.match(/^re\s*:\s*/i) ? subject : `Re: ${subject}`;
}

/**
 * The one-time compose seed for a reply to `target` (whose body should
 * already be resolved via resolveBodyFields): an optional escaped lead
 * paragraph (e.g. an AI suggestion) above the sanitized quoted original.
 * Shared by the thread reader's reply paths and the Reply Queue.
 */
export function buildReplySpec(
	mailboxId: Id<'mailboxes'>,
	target: ReplyQuoteTarget,
	leadText = ''
): Omit<ComposerSpec, 'id' | 'minimized'> {
	const lead = leadText ? `<p>${escapeHtmlWithBreaks(leadText)}</p>` : '';
	return {
		mailboxId,
		inReplyToMessageId: target._id as Id<'mailMessages'>,
		prefillTo: [target.fromAddress],
		prefillSubject: replySubject(target.subject),
		prefillBodyHtml: `${lead}${buildQuotedReply(target)}`,
	};
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

