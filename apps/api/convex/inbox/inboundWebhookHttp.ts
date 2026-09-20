/**
 * Team-inbox (AI shared inbox) webhook handler.
 *
 * Endpoint: POST /webhooks/mta-inbound
 * Events: 'inbound.received'
 *
 * WHY THIS IS NOT A PIPELINE ADAPTER. `inbound.received` used to arrive on
 * `POST /webhooks/mta`, which runs `webhooks/pipeline.ts`, which caps a request
 * body at `MAX_WEBHOOK_BODY_BYTES` (5 MiB) BEFORE authenticating it and answers
 * 413 above that. Now that the payload carries the whole message, that cap
 * would reject any mail over roughly 3.75 MiB of raw bytes — and the MTA reads
 * a 413 as a retryable HTTP failure, so the message would burn six delivery
 * attempts and land in the Redis DLQ where nobody is looking. A standalone
 * `httpAction` never runs the pipeline, so neither of its two byte checks
 * exists on this route and the 10 MiB the inbound listener accepts (~13.3 MiB
 * once base64'd) arrives intact — exactly as it already does on the
 * personal-mailbox route this file is modelled on (`mail/webhookHttp.ts`).
 *
 * Everything the two routes share — the per-source rate limit, the
 * `verifyMtaHeaders` HMAC, the unbounded body read and the bounded audit row —
 * is `webhooks/adapters/mtaRawRoute.ts`, one implementation for both.
 */

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
import { getInboundChannelAdapter } from '../webhooks/adapters/inboundRegistry';

interface InboundWebhookPayload {
	event: 'inbound.received';
	messageId?: string;
	organizationId?: string;
	message?: string;
	timestamp: number;
	inboundPayload: {
		from: string;
		to: string;
		subject: string;
		textBody?: string;
		htmlBody?: string;
		headers: Record<string, string>;
		date?: string;
		messageId?: string;
		inReplyTo?: string;
		references?: string;
		rawBytesBase64?: string;
		attachments: Array<{
			filename?: string;
			contentType: string;
			size: number;
			partIndex?: string;
		}>;
		spfResult?: string;
		dkimResult?: string;
		dmarcResult?: string;
		dmarcPolicy?: string;
	};
}

export const handleInboundWebhook = httpAction(async (ctx, request) => {
	const verified = await readVerifiedMtaBody(ctx, request, {
		logTag: '[Inbound Webhook]',
		rateLimitKeyPrefix: 'mta-inbound',
	});
	if (!verified.ok) return verified.response;
	const { bodyText } = verified;

	let payload: InboundWebhookPayload | null = null;
	try {
		payload = JSON.parse(bodyText) as InboundWebhookPayload;
	} catch {
		payload = null;
	}

	// Audit FIRST, including a body we could not parse — an MTA sending us
	// garbage is precisely what the audit trail is for.
	const ip = payload?.inboundPayload;
	await storeRawRouteAudit(ctx, {
		source: 'mta-inbound',
		logTag: '[Inbound Webhook]',
		bodyText,
		payload,
		envelope: {
			messageId: clampAuditField(ip?.messageId ?? payload?.messageId),
			organizationId: clampAuditField(payload?.organizationId),
			from: clampAuditField(ip?.from),
			to: clampAuditField(ip?.to),
			subject: clampAuditField(ip?.subject),
			rawMessageBytes: base64ByteLength(ip?.rawBytesBase64),
			attachmentCount: Array.isArray(ip?.attachments) ? ip.attachments.length : undefined,
		},
	});

	if (!payload) {
		return jsonResponse(400, { error: 'Invalid JSON' });
	}

	if (payload.event !== 'inbound.received' || !payload.inboundPayload) {
		return jsonResponse(400, { error: `Unsupported event: ${payload.event}` });
	}

	// Envelope normalization is the SHARED parser the legacy `/webhooks/mta`
	// route also runs (`webhooks/adapters/mtaEventParsers.ts`), so the two
	// surfaces cannot drift on field extraction.
	const mail = getInboundChannelAdapter('mta').parseInbound(payload);

	try {
		const result = await ctx.runAction(internal.inbox.inboundIngest.ingestFromWebhook, {
			mail,
			rawBytesBase64: payload.inboundPayload.rawBytesBase64,
		});
		// `duplicate` is a SUCCESS: the MTA retried a delivery we already
		// completed (a slow scan tripped its 10 s fetch timeout, say). Answering
		// 200 is what stops the retry loop; the field is there so an operator
		// reading the MTA's log can tell a re-ack from a first delivery.
		return jsonResponse(200, { success: true, duplicate: result.isDuplicate });
	} catch (err) {
		logError('[Inbound Webhook] Ingest failed:', err);
		return jsonResponse(500, { error: 'Ingest failed' });
	}
});
