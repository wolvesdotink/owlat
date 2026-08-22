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
import { isOstrTier, parseOstrDkimEvidence } from '../ostr/signals';
import { isObserverModeEnabled } from '../ostr/config';

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
		// Open Sender Trust Registry result for the sending identity (plan §12.2),
		// as the MTA's `@owlat/ostr-client` lookup resolved it. Optional — an MTA
		// with `OSTR_ENABLED=false` (the default) or an older build omits it.
		// Declared `unknown` because this whole payload is a `JSON.parse` cast:
		// the value is narrowed by `convex/ostr/signals.ts` below, not trusted.
		ostrTier?: unknown;
		// The DKIM evidence an OBSERVER-MODE MTA captured at verification time —
		// present only when the far side has observer mode on and a signature
		// verified, so absence is the normal case. Now that observer mode has a
		// consumer (`ostr/observer.ts` turns a junk report into a commitment over
		// it), the field is narrowed and forwarded rather than dropped; it is
		// still only RETAINED when this side has observer mode on too, because the
		// bundle carries raw signed headers and a point-in-time DNS key record.
		//
		// `ostrScore` is still ignored: the tier is the only consumer-side value
		// with a column and a meaning, and an unread number is a field that will
		// go stale in storage.
		ostrDkimEvidence?: unknown;
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
		return new Response(JSON.stringify({ error: `Unsupported event: ${payload.event}` }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const mp = payload.mailboxPayload;

	// OSTR (plan §12.2): narrow the registry tier HERE, at the boundary, rather
	// than handing it to the action's validator. A malformed tier is DROPPED and
	// the message delivers exactly as it would have without OSTR — the tier is an
	// advisory signal (§6.1), so it must never be able to cost us a delivery. The
	// signature already proved the payload came from our own MTA; this is the
	// second half of that, which is that a bug on the far side stays a bug.
	const ostrTier = isOstrTier(mp.ostrTier) ? mp.ostrTier : undefined;
	// Same rule for the evidence bundle: shape-narrowed here, judged later.
	// Whether these bytes are ADMISSIBLE evidence is `@owlat/ostr-core`'s call,
	// made on the report path, and a malformed bundle must cost a future report
	// rather than this delivery.
	//
	// Gated on observer mode AT THE BOUNDARY, not just at the writer. A bundle
	// carries the `h=`-signed headers verbatim (From, To, Subject) plus the DNS
	// key record — data this deployment should accept only when something is
	// about to use it. Observer mode is that consumer; with it off, the field is
	// dropped where it arrives rather than parsed, rebuilt and carried across two
	// function boundaries on every inbound message. `deliverToMailbox` re-checks
	// before it writes, which is defence in depth rather than the gate.
	const ostrDkimEvidence = isObserverModeEnabled()
		? parseOstrDkimEvidence(mp.ostrDkimEvidence)
		: undefined;

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
			ostrTier,
			ostrDkimEvidence,
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
