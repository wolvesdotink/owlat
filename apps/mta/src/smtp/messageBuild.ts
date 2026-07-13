/**
 * Pure message-construction helpers for the direct-MX sender: the plain-text
 * fallback derived from HTML, and the From-aligned RFC 5322 Message-ID.
 */

import { randomBytes } from 'node:crypto';

/**
 * Strip HTML tags and decode entities to produce a plain text fallback.
 * Used when the caller doesn't provide an explicit text part.
 */
export function stripHtml(html: string): string {
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

/**
 * Build an RFC 5322 §3.6.4 Message-ID `<unique@domain>` whose right-hand-side
 * domain is the From sending domain. Mirrors `apps/api/convex/mail/rfc822.ts`
 * `buildMessageId` (ms timestamp + 48 random bits = collision-resistant).
 *
 * The bulk/campaign/transactional path never sets Message-ID, so nodemailer
 * auto-derives it from `envelope.from` — which is the VERP return-path
 * (`bounces.<domain>`), NOT the From domain. Stamping it explicitly here
 * From-aligns the Message-ID for brand/deliverability consistency with the
 * postbox path and short-circuits nodemailer's `getHeader('Message-ID')`
 * default (mime-node:922-929).
 */
export function buildMessageId(domain: string): string {
	return `<${Date.now().toString(36)}.${randomBytes(6).toString('hex')}@${domain}>`;
}
