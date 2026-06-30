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
 * verification the main MTA webhook uses — and audit-stores the raw payload.
 * The postbox dispatch target (mail.delivery.ingestFromWebhook) is distinct
 * from the customer-inbound dispatcher, so this stays a standalone handler
 * rather than a runInboundPipeline adapter.
 */

import { httpAction } from '../_generated/server';
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
	};
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

	// Audit-store the raw payload (non-blocking — never fail the webhook on it),
	// matching runInboundPipeline. The postbox inbound path previously skipped this.
	try {
		await ctx.runMutation(internal.webhooks.payloads.store, {
			source: 'mta-mailbox',
			rawPayload: bodyText,
		});
	} catch {
		// intentionally swallowed
	}

	let payload: MailWebhookPayload;
	try {
		payload = JSON.parse(bodyText) as MailWebhookPayload;
	} catch {
		return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	if (payload.event !== 'inbound.mailbox.received' || !payload.mailboxPayload) {
		return new Response(
			JSON.stringify({ error: `Unsupported event: ${payload.event}` }),
			{ status: 400, headers: { 'Content-Type': 'application/json' } }
		);
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
