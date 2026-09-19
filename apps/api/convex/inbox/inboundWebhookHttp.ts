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
 * `httpAction` simply never imports the pipeline, so neither of its two byte
 * checks exists on this route and the 10 MiB the inbound listener accepts
 * (~13.3 MiB once base64'd) arrives intact — exactly as it already does on the
 * personal-mailbox route this file is modelled on (`mail/webhookHttp.ts`).
 *
 * Everything else about the two routes is deliberately identical: per-source
 * rate limiting before any work, the shared `verifyMtaHeaders` HMAC, a bounded
 * audit row, and dispatch into an internal action.
 */

import { httpAction } from '../_generated/server';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { getClientIp, rateLimitedResponse } from '../publicRateLimit';
import { logError } from '../lib/runtimeLog';
import { getOptional } from '../lib/env';
import { verifyMtaHeaders } from '../webhooks/adapters/mta';
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

/**
 * AUDIT, NOT A SECOND COPY OF THE MAIL — the same decision `mail/webhookHttp.ts`
 * documents at length. This route's body carries the entire message, and a
 * `webhookPayloads` row is one Convex document capped at 1 MiB, so storing the
 * body verbatim would throw into a swallowing `catch` for precisely the
 * messages that have attachments: the audit trail would exist only for the mail
 * nobody needs it for. A digest plus the envelope answers "did these bytes
 * arrive, when, from whom" better than a copy does, because it also proves the
 * bytes were not altered afterwards.
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
 * Decoded size of a base64 string without decoding it. The parsed body is JSON
 * whose shape we have only ASSERTED, so a numeric or object `rawBytesBase64` is
 * truthy and would throw on a string method — inside the audit writer, which is
 * the one place a throw means "the row silently does not exist". MIME wraps
 * base64 at 76 columns (RFC 2045 §6.8), so whitespace and padding come off
 * before the arithmetic or the answer over-reports against the `rawSize` it
 * exists to be compared with.
 */
function base64ByteLength(value: unknown): number | undefined {
	if (typeof value !== 'string') return undefined;
	const base64Chars = value.replace(/[\s=]+/g, '').length;
	return Math.floor((base64Chars * 3) / 4);
}

/** What the MTA sent us, as an operator reads it. */
function auditEventLabel(payload: InboundWebhookPayload | null): string {
	if (payload === null) return 'unparseable';
	return clampAuditField(payload.event) ?? 'missing-event';
}

/**
 * Write the bounded audit row for one inbound message. Never fails the webhook
 * — mail that arrived is not dropped because its audit row would not write —
 * but it SAYS so when it could not write, because an audit that can fail
 * invisibly is worse than no audit at all.
 */
async function auditInbound(
	ctx: ActionCtx,
	bodyText: string,
	payload: InboundWebhookPayload | null
): Promise<void> {
	try {
		const ip = payload?.inboundPayload;
		const summary = {
			version: AUDIT_SUMMARY_VERSION,
			event: auditEventLabel(payload),
			bodyChars: bodyText.length,
			bodySha256: await sha256Hex(bodyText),
			messageId: clampAuditField(ip?.messageId ?? payload?.messageId),
			organizationId: clampAuditField(payload?.organizationId),
			from: clampAuditField(ip?.from),
			to: clampAuditField(ip?.to),
			subject: clampAuditField(ip?.subject),
			rawMessageBytes: base64ByteLength(ip?.rawBytesBase64),
			attachmentCount: Array.isArray(ip?.attachments) ? ip.attachments.length : undefined,
			// A body we could not parse has no envelope to summarise, so the row
			// would be a digest of bytes nobody can read. Keep a bounded head of the
			// garbage — it is the whole reason anyone opens THIS row. A parseable
			// body keeps none, because on this route the body IS the message.
			...(payload === null ? { head: clampAuditField(bodyText) } : {}),
		};
		await ctx.runMutation(internal.webhooks.payloads.store, {
			source: 'mta-inbound',
			rawPayload: JSON.stringify(summary),
		});
	} catch (error) {
		logError('[Inbound Webhook] Failed to store the delivery audit row:', error);
	}
}

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

export const handleInboundWebhook = httpAction(async (ctx, request) => {
	if (request.method !== 'POST') {
		return json({ error: 'Method not allowed' }, 405);
	}

	// Per-source rate-limit key (`mta-inbound:<ip>`) so a flood here cannot drain
	// the shared 'webhookIngestion' bucket and 429 the provider bounce/complaint
	// webhooks. Coarse by design: `getClientIp` returns 'unknown' for every
	// caller unless RATE_LIMIT_TRUSTED_PROXY is set, so on a default deployment
	// this is one shared bucket. The real spend control is the per-sender
	// attachment budget charged at the capture site, not this.
	const ip = getClientIp(request);
	const { ok, retryAfter } = await ctx.runMutation(internal.publicRateLimit.checkPublicRateLimit, {
		limitType: 'webhookIngestion',
		key: `mta-inbound:${ip}`,
	});
	if (!ok) {
		return rateLimitedResponse(retryAfter);
	}

	const secret = getOptional('MTA_WEBHOOK_SECRET');
	if (!secret) {
		logError('[Inbound Webhook] MTA_WEBHOOK_SECRET is not configured');
		return json({ error: 'Webhook endpoint not configured' }, 503);
	}

	const signature = request.headers.get('x-mta-signature');
	const mtaTimestamp = request.headers.get('x-mta-timestamp');
	if (!signature || !mtaTimestamp) {
		logError('[Inbound Webhook] Missing X-MTA-Signature or X-MTA-Timestamp');
		return json({ error: 'Missing signature headers' }, 401);
	}

	// UNBOUNDED, and that is the point of this file — see the header.
	let bodyText: string;
	try {
		bodyText = await request.text();
	} catch {
		return json({ error: 'Failed to read request body' }, 400);
	}

	// HMAC-SHA256 over `${timestamp}.${body}` + the 5-minute staleness check,
	// shared with the other two MTA routes so they can never drift on the scheme.
	if (!(await verifyMtaHeaders(bodyText, signature, mtaTimestamp, secret))) {
		logError('[Inbound Webhook] Invalid signature or stale timestamp');
		return json({ error: 'Invalid signature' }, 401);
	}

	let payload: InboundWebhookPayload | null = null;
	try {
		payload = JSON.parse(bodyText) as InboundWebhookPayload;
	} catch {
		payload = null;
	}

	// Audit FIRST, including a body we could not parse — an MTA sending us
	// garbage is precisely what the audit trail is for.
	await auditInbound(ctx, bodyText, payload);

	if (!payload) {
		return json({ error: 'Invalid JSON' }, 400);
	}

	if (payload.event !== 'inbound.received' || !payload.inboundPayload) {
		return json({ error: `Unsupported event: ${payload.event}` }, 400);
	}

	// Envelope normalization is the SHARED parser the legacy `/webhooks/mta`
	// route also runs (`webhooks/adapters/mtaEventParsers.ts`), so the two
	// surfaces cannot drift on field extraction.
	const mail = getInboundChannelAdapter('mta').parseInbound(payload);

	try {
		await ctx.runAction(internal.inbox.inboundIngest.ingestFromWebhook, {
			mail,
			rawBytesBase64: payload.inboundPayload.rawBytesBase64,
		});
		return json({ success: true }, 200);
	} catch (err) {
		logError('[Inbound Webhook] Ingest failed:', err);
		return json({ error: 'Ingest failed' }, 500);
	}
});
