/**
 * Personal-Mail (Postbox) Webhook Handler
 *
 * Receives inbound delivery events from owlat-mta for per-user mailboxes.
 * Distinct from /webhooks/mta which handles bounces, complaints, IP
 * reputation events, and from /webhooks/mta-inbound which handles the
 * AI-shared inbox flow.
 *
 * Endpoint: POST /webhooks/mta-mailbox
 * Events: 'inbound.mailbox.received'
 *
 * The preamble every raw-body MTA route shares — per-source rate limit, secret
 * lookup, the `verifyMtaHeaders` HMAC + 5-minute staleness window, the
 * unbounded body read and the bounded digest-not-a-copy audit row — lives in
 * `webhooks/adapters/mtaRawRoute.ts`, so this route and the team-inbox one
 * cannot drift on any of it. What stays here is the payload shape, the event
 * check, the envelope fields worth auditing and the postbox dispatch target
 * (mail.delivery.ingestFromWebhook), which is distinct from the customer-inbound
 * dispatcher — hence a standalone handler rather than a runInboundPipeline
 * adapter.
 */

import { isOstrTier, parseOstrDkimEvidence } from '../ostr/signals';
import { isObserverModeEnabled } from '../ostr/config';
import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { logError } from '../lib/runtimeLog';
import { jsonResponse } from '../webhooks/inboundHttp';
import {
	base64ByteLength,
	clampAuditField,
	readVerifiedMtaBody,
	storeRawRouteAudit,
} from '../webhooks/adapters/mtaRawRoute';

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
		ostrTier?: unknown;
		ostrDkimEvidence?: unknown;
	};
}

export const handleMailWebhook = httpAction(async (ctx, request) => {
	const verified = await readVerifiedMtaBody(ctx, request, {
		logTag: '[Mail Webhook]',
		rateLimitKeyPrefix: 'mta-mailbox',
	});
	if (!verified.ok) return verified.response;
	const { bodyText } = verified;

	let payload: MailWebhookPayload | null = null;
	try {
		payload = JSON.parse(bodyText) as MailWebhookPayload;
	} catch {
		payload = null;
	}

	// Audit FIRST, including a body we could not parse — an MTA sending us
	// garbage is precisely the thing the audit trail is for.
	const mpAudit = payload?.mailboxPayload;
	await storeRawRouteAudit(ctx, {
		source: 'mta-mailbox',
		logTag: '[Mail Webhook]',
		bodyText,
		payload,
		envelope: {
			deliveryId: clampAuditField(mpAudit?.deliveryId),
			messageId: clampAuditField(mpAudit?.messageId),
			recipientAddress: clampAuditField(mpAudit?.recipientAddress),
			from: clampAuditField(mpAudit?.from),
			rawMessageBytes: base64ByteLength(mpAudit?.rawBytesBase64),
			attachmentCount: mpAudit?.attachments?.length,
		},
	});

	if (!payload) {
		return jsonResponse(400, { error: 'Invalid JSON' });
	}

	if (payload.event !== 'inbound.mailbox.received' || !payload.mailboxPayload) {
		return jsonResponse(400, { error: `Unsupported event: ${payload.event}` });
	}

	const mp = payload.mailboxPayload;
	// Invalid advisory data must never prevent delivery; retain evidence only by opt-in.
	const ostrTier = isOstrTier(mp.ostrTier) ? mp.ostrTier : undefined;
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

		return jsonResponse(200, { success: true, result });
	} catch (err) {
		logError('[Mail Webhook] Delivery failed:', err);
		return jsonResponse(500, { error: 'Delivery failed' });
	}
});
