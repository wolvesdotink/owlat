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
 * exists on this route and a message at the 10 MiB the inbound listener accepts
 * (~13.3 MiB once base64'd) arrives intact — exactly as it already does on the
 * personal-mailbox route this file is modelled on (`mail/webhookHttp.ts`).
 *
 * The one remaining ceiling is Convex's own: a function's ARGUMENTS are capped
 * at 16 MiB, and this handler forwards the base64 raw plus the parsed bodies
 * the MTA also sent. Near the listener limit those can add up past the cap, so
 * the forward is budgeted — see `MAX_FORWARDED_ARG_BYTES` below — and the mail
 * is delivered without its raw bytes rather than 500'd into the DLQ.
 *
 * Everything the two routes share — the per-source rate limit, the
 * `verifyMtaHeaders` HMAC, the unbounded body read and the bounded audit row —
 * is `webhooks/adapters/mtaRawRoute.ts`, one implementation for both. The
 * argument budget is NOT shared: it lives below, because only this route has a
 * deliver-without-the-raw branch to take when it trips.
 */

import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { logError, logWarn } from '../lib/runtimeLog';
import { jsonResponse } from '../webhooks/inboundHttp';
import {
	base64ByteLength,
	clampAuditField,
	readVerifiedMtaBody,
	storeRawRouteAudit,
} from '../webhooks/adapters/mtaRawRoute';
import {
	getInboundChannelAdapter,
	type MtaInboundWirePayload,
} from '../webhooks/adapters/inboundRegistry';

/**
 * Convex caps a function's ARGUMENTS at 16 MiB. Budgeted below that so the
 * overhead this route forwards beside the strings — headers, the attachment
 * metadata, the envelope fields — cannot be what tips a message over.
 */
const MAX_FORWARDED_ARG_BYTES = 15 * 1024 * 1024;

/**
 * Do these caller-supplied strings fit in one `ctx.runAction` argument?
 *
 * THIS ROUTE'S CEILING, not a shared one. It forwards the base64 message AND
 * the bodies the MTA already parsed out of it, so a 10 MiB message (13.3 MiB
 * base64) with a few megabytes of HTML clears the cap between them.
 * `runAction` THROWS there, the route answers 500, and the MTA — which reads
 * 5xx as retryable — burns its attempts and dead-letters mail that was
 * perfectly deliverable. The answer here is to forward the message WITHOUT its
 * raw bytes, which is exactly what the pre-raw route always delivered.
 *
 * The sibling mailbox route (`mail/webhookHttp.ts`) has no such branch to
 * take: `rawBytesBase64` is a REQUIRED argument of
 * `mail.delivery.ingestFromWebhook`, so dropping it there is not "deliver
 * less", it is "do not deliver". Rather than let a shared helper imply a cover
 * it does not give, the budget lives with the one route that can act on it.
 *
 * Measured in UTF-8 BYTES, not characters: the cap is on bytes, and a body of
 * non-ASCII text costs up to three of them per UTF-16 code unit.
 */
export function fitsForwardedArgBudget(values: Array<string | undefined>): boolean {
	const strings = values.filter((value): value is string => typeof value === 'string');
	// One UTF-16 code unit is at least one UTF-8 byte and at most three, so the
	// character count decides both extremes without encoding anything. Only the
	// band in between — where a body of non-ASCII text could be the difference —
	// pays for an exact measurement.
	const chars = strings.reduce((sum, value) => sum + value.length, 0);
	if (chars > MAX_FORWARDED_ARG_BYTES) return false;
	if (chars * 3 <= MAX_FORWARDED_ARG_BYTES) return true;
	const encoder = new TextEncoder();
	let bytes = 0;
	for (const value of strings) {
		bytes += encoder.encode(value).byteLength;
		if (bytes > MAX_FORWARDED_ARG_BYTES) return false;
	}
	return true;
}

export const handleInboundWebhook = httpAction(async (ctx, request) => {
	const verified = await readVerifiedMtaBody(ctx, request, {
		logTag: '[Inbound Webhook]',
		rateLimitKeyPrefix: 'mta-inbound',
	});
	if (!verified.ok) return verified.response;
	const { bodyText } = verified;

	let payload: MtaInboundWirePayload | null = null;
	try {
		payload = JSON.parse(bodyText) as MtaInboundWirePayload;
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
	// surfaces cannot drift on field extraction. Named `input` on purpose:
	// `check-body-access.sh` treats a body-field read off any other receiver as
	// a stored-row read, and this is the INGEST BOUNDARY — every field came off
	// the wire, never out of the database.
	const input = getInboundChannelAdapter('mta').parseInbound(payload);

	// THE BODIES WIN OVER THE BYTES. A message near the listener cap whose
	// parsed text/HTML is also large can push the forwarded argument past
	// Convex's 16 MiB limit, and `runAction` would throw — a 500 the MTA retries
	// six times and then dead-letters. Dropping the raw instead delivers exactly
	// what the pre-raw route always delivered: the message, its bodies and its
	// metadata, with no downloadable `.eml` and no attachment capture. Losing an
	// attachment on an outsized message beats losing the message.
	const rawBytesBase64 = fitsForwardedArgBudget([
		payload.inboundPayload.rawBytesBase64,
		input.textBody,
		input.htmlBody,
	])
		? payload.inboundPayload.rawBytesBase64
		: undefined;
	if (payload.inboundPayload.rawBytesBase64 && !rawBytesBase64) {
		logWarn('[Inbound Webhook] payload over the action-argument budget — stored without raw', {
			messageId: input.messageId,
			rawMessageBytes: base64ByteLength(payload.inboundPayload.rawBytesBase64),
		});
	}

	try {
		const result = await ctx.runAction(internal.inbox.inboundIngest.ingestFromWebhook, {
			mail: input,
			rawBytesBase64,
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
