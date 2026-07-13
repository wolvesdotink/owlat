/**
 * Pure message-construction helpers for the direct-MX sender: the plain-text
 * fallback derived from HTML, and the From-aligned RFC 5322 Message-ID.
 */

import { randomBytes } from 'node:crypto';
import type { SendMailOptions } from 'nodemailer';
import type { EmailJob } from '../types.js';

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

/**
 * Assemble the nodemailer `sendMail` payload for a direct-MX delivery: the body
 * parts (with an HTML-derived text fallback and optional AMP alternative),
 * decoded attachments, the tracing headers, and the VERP envelope. Pure — the
 * caller owns the transport, the TLS profile, and the secured-flag capture.
 *
 * @param messageIdHeader Explicit From-aligned Message-ID to stamp, or
 *   `undefined` when the caller-supplied headers already carry one.
 */
export function buildSendMailPayload(
	job: EmailJob,
	verpAddress: string,
	messageIdHeader: string | undefined
): SendMailOptions {
	return {
		from: job.from,
		to: job.to,
		subject: job.subject,
		html: job.html,
		text: job.text || stripHtml(job.html),
		// nodemailer emits AMP as a `text/x-amp-html` alternative part,
		// ordered so non-AMP clients fall through to the HTML part.
		...(job.amp ? { amp: job.amp } : {}),
		// Internally-generated mail (e.g. TLS-RPT reports) may carry binary
		// attachments. base64-encoded on the job so they survive Redis JSON.
		...(job.attachments && job.attachments.length > 0
			? {
					attachments: job.attachments.map((a) => ({
						filename: a.filename,
						contentType: a.contentType,
						content: Buffer.from(a.contentBase64, 'base64'),
					})),
				}
			: {}),
		replyTo: job.replyTo,
		headers: {
			...job.headers,
			...(messageIdHeader ? { 'Message-ID': messageIdHeader } : {}),
			'X-Owlat-Message-Id': job.messageId,
			'X-Owlat-Org-Id': job.organizationId,
		},
		envelope: {
			from: verpAddress,
			to: job.to,
		},
	};
}
