/**
 * Personal-Mail (Postbox) Webhook Handler
 *
 * Receives inbound delivery events from owlat-mta for per-user mailboxes.
 * Distinct from /webhooks/mta which handles bounces, complaints, IP
 * reputation events, and the AI-shared inbox flow.
 *
 * Endpoint: POST /webhooks/mta-mailbox
 * Events: 'inbound.mailbox.received'
 *
 * Reuses the shared verifyMtaHeaders (HMAC-SHA256 over `${timestamp}.${body}` +
 * 5-minute staleness window) from webhooks/adapters/mta.ts — the same
 * verification the main MTA webhook uses — and audit-stores a bounded SUMMARY of
 * the delivery (see `auditDelivery` below; the body carries the whole message,
 * so retaining it verbatim would keep a second copy of every email).
 * The postbox dispatch target (mail.delivery.ingestFromWebhook) is distinct
 * from the customer-inbound dispatcher, so this stays a standalone handler
 * rather than a runInboundPipeline adapter.
 */

import { httpAction } from '../_generated/server';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { getClientIp, rateLimitedResponse } from '../publicRateLimit';
import { logError } from '../lib/runtimeLog';
import { getOptional } from '../lib/env';
import { verifyMtaHeaders } from '../webhooks/adapters/mta';

interface MailWebhookAttachment {
	filename: string;
	contentType: string;
	size: number;
	contentId?: string;
	partIndex: string;
}

interface MailWebhookPayload {
	event: 'inbound.mailbox.received';
	messageId?: string;
	organizationId?: string;
	message?: string;
	timestamp: number;
	mailboxPayload: {
		deliveryId: string;
		recipientAddress: string;
		rawBytesBase64: string;
		from: string;
		to: string[];
		cc?: string[];
		bcc?: string[];
		replyTo?: string;
		// SMTP envelope sender (RFC 5321 MAIL FROM); `''` for a bounce/DSN null
		// sender. Used to suppress vacation auto-replies to bounces (RFC 3834 §2).
		returnPath?: string;
		subject: string;
		textBody?: string;
		htmlBody?: string;
		messageId: string;
		inReplyTo?: string;
		references?: string;
		date?: number;
		attachments?: MailWebhookAttachment[];
		spamScore?: number;
		spamVerdict?: 'ham' | 'spam' | 'quarantine';
		virusVerdict?: 'clean' | 'infected' | 'skipped';
		spfResult?: string;
		dkimResult?: string;
		dmarcResult?: string;
		dmarcPolicy?: string;
		// DMARC alignment inputs (envelope MAIL FROM domain + DKIM d= domain),
		// stored beside the verdicts on `mailMessages`. Both optional.
		envelopeFromDomain?: string;
		dkimSigningDomain?: string;
		// Verified inbound ARC verdict (RFC 8617, Sealed Mail A5). Used to rescue a
		// DMARC fail when a TRUSTED forwarder sealed a valid chain attesting the
		// original passed. All optional — an older MTA omits them (no rescue).
		arcCv?: string;
		arcSealerDomain?: string;
		arcAttestsOriginalPass?: boolean;
	};
}

/**
 * AUDIT, NOT A SECOND COPY OF THE MAIL.
 *
 * This route's body carries `rawBytesBase64` — the entire message. Retaining it
 * verbatim in `webhookPayloads` kept a second full base64 copy of every email in
 * the database for 90 days beside the `_storage` blob that already holds it, and
 * for anything over roughly 768 KiB raw the insert hit the 1 MiB document cap and
 * threw into a bare `catch`, so the audit trail silently did not exist for
 * exactly the messages that have attachments.
 *
 * What a delivery dispute actually asks is "did these bytes arrive, when, from
 * whom, for whom" — which a digest answers better than a copy, because a digest
 * also proves the bytes were not altered afterwards. So we keep the SHA-256 of
 * the exact body we verified the HMAC over, its size, and the envelope
 * identifiers. The message content (subject, bodies, attachment payloads) stays
 * only in the mailbox, where retention and erasure already govern it.
 */
const AUDIT_SUMMARY_VERSION = 1;

/** Cap on any single caller-supplied string copied into the audit row. */
const AUDIT_FIELD_MAX_CHARS = 256;

function clampAuditField(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length === 0) return undefined;
	return value.length > AUDIT_FIELD_MAX_CHARS ? value.slice(0, AUDIT_FIELD_MAX_CHARS) : value;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Decoded size of a base64 string, without decoding it — `undefined` when the
 * MTA sent something that is not a string at all.
 *
 * The parsed body is JSON we have only ASSERTED a shape for; nothing validates
 * it. A numeric or object `rawBytesBase64` is truthy, so it used to reach
 * `value.endsWith` and throw a `TypeError` into `auditDelivery`'s catch — the
 * delivery then succeeded with NO audit row at all, the exact silent gap this
 * function exists inside of.
 *
 * MIME wraps base64 at 76 columns (RFC 2045 §6.8), so the line breaks have to
 * come off before the arithmetic or the answer over-reports against the
 * `rawSize` it exists to be compared with. With whitespace and padding gone,
 * each 4 characters are 3 bytes and a 2- or 3-character tail is 1 or 2 bytes —
 * `floor(n * 3 / 4)` exactly, no padding correction needed.
 */
function base64ByteLength(value: unknown): number | undefined {
	if (typeof value !== 'string') return undefined;
	const base64Chars = value.replace(/[\s=]+/g, '').length;
	return Math.floor((base64Chars * 3) / 4);
}

/**
 * The `event` label an operator reads as "what did the MTA send us".
 *
 * Two different failures used to collapse into `'unparseable'`: a body that is
 * not JSON at all, and a perfectly parseable body whose `event` is a number or
 * an object. Only the first is the MTA speaking nonsense at the wire level, and
 * telling an operator the wrong one sends them to the wrong side of the link.
 */
function auditEventLabel(payload: MailWebhookPayload | null): string {
	if (payload === null) return 'unparseable';
	return clampAuditField(payload.event) ?? 'missing-event';
}

/**
 * Write the bounded audit row for one inbound delivery. Never fails the webhook
 * — a message that arrived is not dropped because its audit row would not write
 * — but it SAYS so when it could not write, because an audit that can fail
 * invisibly is worse than no audit at all.
 */
async function auditDelivery(
	ctx: ActionCtx,
	bodyText: string,
	payload: MailWebhookPayload | null
): Promise<void> {
	try {
		const mp = payload?.mailboxPayload;
		const summary = {
			version: AUDIT_SUMMARY_VERSION,
			event: auditEventLabel(payload),
			bodyChars: bodyText.length,
			bodySha256: await sha256Hex(bodyText),
			deliveryId: clampAuditField(mp?.deliveryId),
			messageId: clampAuditField(mp?.messageId),
			recipientAddress: clampAuditField(mp?.recipientAddress),
			from: clampAuditField(mp?.from),
			rawMessageBytes: base64ByteLength(mp?.rawBytesBase64),
			attachmentCount: mp?.attachments?.length,
			// A body we could not parse has no envelope fields to summarise, so the
			// row would be a digest of bytes nobody can read — proof only that we
			// could not read them either. Keep a bounded head of the garbage: it is
			// the whole reason anyone opens THIS row. A parseable body keeps none,
			// because on this route the body IS the message.
			...(payload === null ? { head: clampAuditField(bodyText) } : {}),
		};
		await ctx.runMutation(internal.webhooks.payloads.store, {
			source: 'mta-mailbox',
			rawPayload: JSON.stringify(summary),
		});
	} catch (error) {
		logError('[Mail Webhook] Failed to store the delivery audit row:', error);
	}
}

export const handleMailWebhook = httpAction(async (ctx, request) => {
	if (request.method !== 'POST') {
		return new Response(JSON.stringify({ error: 'Method not allowed' }), {
			status: 405,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	// Per-source rate-limit key (`mta-mailbox:<ip>`) so a flood here can't drain
	// the shared 'webhookIngestion' bucket and 429 the provider bounce/complaint
	// webhooks (getClientIp() is 'unknown' for all callers when
	// RATE_LIMIT_TRUSTED_PROXY is unset). See webhooks/pipeline.ts for the rationale.
	const ip = getClientIp(request);
	const { ok, retryAfter } = await ctx.runMutation(internal.publicRateLimit.checkPublicRateLimit, {
		limitType: 'webhookIngestion',
		key: `mta-mailbox:${ip}`,
	});
	if (!ok) {
		return rateLimitedResponse(retryAfter);
	}

	const secret = getOptional('MTA_WEBHOOK_SECRET');
	if (!secret) {
		logError('[Mail Webhook] MTA_WEBHOOK_SECRET is not configured');
		return new Response(JSON.stringify({ error: 'Webhook endpoint not configured' }), {
			status: 503,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const signature = request.headers.get('x-mta-signature');
	const mtaTimestamp = request.headers.get('x-mta-timestamp');
	if (!signature || !mtaTimestamp) {
		logError('[Mail Webhook] Missing X-MTA-Signature or X-MTA-Timestamp');
		return new Response(JSON.stringify({ error: 'Missing signature headers' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	let bodyText: string;
	try {
		bodyText = await request.text();
	} catch {
		return new Response(JSON.stringify({ error: 'Failed to read request body' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	// HMAC-SHA256 over `${timestamp}.${body}` + the 5-minute timestamp-staleness
	// check, shared with the main MTA webhook (webhooks/adapters/mta.ts) so the
	// two inbound paths can never drift on the signature scheme.
	if (!(await verifyMtaHeaders(bodyText, signature, mtaTimestamp, secret))) {
		logError('[Mail Webhook] Invalid signature or stale timestamp');
		return new Response(JSON.stringify({ error: 'Invalid signature' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	let payload: MailWebhookPayload | null = null;
	try {
		payload = JSON.parse(bodyText) as MailWebhookPayload;
	} catch {
		payload = null;
	}

	// Audit FIRST, including a body we could not parse — an MTA sending us
	// garbage is precisely the thing the audit trail is for.
	await auditDelivery(ctx, bodyText, payload);

	if (!payload) {
		return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	if (payload.event !== 'inbound.mailbox.received' || !payload.mailboxPayload) {
		return new Response(JSON.stringify({ error: `Unsupported event: ${payload.event}` }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const mp = payload.mailboxPayload;

	try {
		const result = await ctx.runAction(internal.mail.delivery.ingestFromWebhook, {
			deliveryId: mp.deliveryId,
			rawBytesBase64: mp.rawBytesBase64,
			recipientAddress: mp.recipientAddress,
			from: mp.from,
			to: mp.to,
			cc: mp.cc ?? [],
			bcc: mp.bcc ?? [],
			replyTo: mp.replyTo,
			returnPath: mp.returnPath,
			subject: mp.subject || '(no subject)',
			textBody: mp.textBody,
			htmlBody: mp.htmlBody,
			messageId: mp.messageId,
			inReplyTo: mp.inReplyTo,
			references: mp.references,
			date: mp.date,
			attachments: mp.attachments ?? [],
			spamScore: mp.spamScore,
			spamVerdict: mp.spamVerdict,
			virusVerdict: mp.virusVerdict,
			spfResult: mp.spfResult,
			dkimResult: mp.dkimResult,
			dmarcResult: mp.dmarcResult,
			dmarcPolicy: mp.dmarcPolicy,
			arcCv: mp.arcCv,
			arcSealerDomain: mp.arcSealerDomain,
			arcAttestsOriginalPass: mp.arcAttestsOriginalPass,
			envelopeFromDomain: mp.envelopeFromDomain,
			dkimSigningDomain: mp.dkimSigningDomain,
		});

		return new Response(JSON.stringify({ success: true, result }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (err) {
		logError('[Mail Webhook] Delivery failed:', err);
		return new Response(JSON.stringify({ error: 'Delivery failed' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
});
