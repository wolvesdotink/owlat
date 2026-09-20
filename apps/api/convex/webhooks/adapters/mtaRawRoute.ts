/**
 * The shared middle of the two MTA routes whose body IS the message.
 *
 * `POST /webhooks/mta-mailbox` (`mail/webhookHttp.ts`) and
 * `POST /webhooks/mta-inbound` (`inbox/inboundWebhookHttp.ts`) both stand
 * outside `webhooks/pipeline.ts` for the same reason — the pipeline caps a
 * request body at `MAX_WEBHOOK_BODY_BYTES` before authenticating it, and these
 * two carry whole messages — and therefore both had to re-implement the
 * pipeline's preamble. They did, character for character: the per-source rate
 * limit, the secret lookup, the header check, the body read, the shared HMAC +
 * staleness verification, and a bounded digest-not-a-copy audit row.
 *
 * That duplication is what this module ends. The next audit-shape bump, header
 * rename or staleness change lands once; neither route can silently keep the
 * old one. What stays in each route file is what genuinely differs: its payload
 * interface, its event check, the envelope fields it summarises, and the action
 * it dispatches into.
 */

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { getClientIp, rateLimitedResponse } from '../../publicRateLimit';
import { logError } from '../../lib/runtimeLog';
import { getOptional } from '../../lib/env';
import { verifyMtaHeaders } from './mta';
import { jsonResponse } from '../inboundHttp';

/**
 * AUDIT, NOT A SECOND COPY OF THE MAIL.
 *
 * These routes' bodies carry `rawBytesBase64` — the entire message. Retaining
 * one verbatim in `webhookPayloads` kept a second full base64 copy of every
 * email in the database beside the `_storage` blob that already holds it, and
 * for anything over roughly 768 KiB raw the insert hit the 1 MiB document cap
 * and threw into a bare `catch`, so the audit trail silently did not exist for
 * exactly the messages that have attachments.
 *
 * What a delivery dispute actually asks is "did these bytes arrive, when, from
 * whom, for whom" — which a digest answers better than a copy does, because a
 * digest also proves the bytes were not altered afterwards. So we keep the
 * SHA-256 of the exact body we verified the HMAC over, its size, and the
 * envelope identifiers. The message content stays only where retention and
 * erasure already govern it.
 */
export const AUDIT_SUMMARY_VERSION = 1;

/** Cap on any single caller-supplied string copied into an audit row. */
const AUDIT_FIELD_MAX_CHARS = 256;

/** A caller-supplied string, bounded — or absent when it is not a string at all. */
export function clampAuditField(value: unknown): string | undefined {
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
 * `value.endsWith` and throw a `TypeError` into the audit writer's catch — the
 * delivery then succeeded with NO audit row at all, the exact silent gap this
 * function exists inside of.
 *
 * MIME wraps base64 at 76 columns (RFC 2045 §6.8), so the line breaks have to
 * come off before the arithmetic, or the audit row reports a size larger than
 * the `rawSize` the receiving side records for the same message and an operator
 * reading the two side by side concludes bytes went missing. With whitespace
 * and padding gone, each 4 characters are 3 bytes and a 2- or 3-character tail
 * is 1 or 2 bytes — `floor(n * 3 / 4)` exactly, no padding correction needed.
 */
export function base64ByteLength(value: unknown): number | undefined {
	if (typeof value !== 'string') return undefined;
	const base64Chars = value.replace(/[\s=]+/g, '').length;
	return Math.floor((base64Chars * 3) / 4);
}

/**
 * Convex caps a function's ARGUMENTS at 16 MiB. Budgeted below that so the
 * overhead these routes forward beside the strings — headers, the attachment
 * metadata, the envelope fields — cannot be what tips a message over.
 */
const MAX_FORWARDED_ARG_BYTES = 15 * 1024 * 1024;

/**
 * Do these caller-supplied strings fit in one `ctx.runAction` argument?
 *
 * The raw-carrying routes forward the base64 message AND the bodies the MTA
 * already parsed out of it, so a 10 MiB message (13.3 MiB base64) with a few
 * megabytes of HTML clears the cap between them. `runAction` THROWS there, the
 * route answers 500, and the MTA — which reads 5xx as retryable — burns its
 * attempts and dead-letters mail that was perfectly deliverable.
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

/**
 * The `event` label an operator reads as "what did the MTA send us".
 *
 * Two different failures used to collapse into `'unparseable'`: a body that is
 * not JSON at all, and a perfectly parseable body whose `event` is a number or
 * an object. Only the first is the MTA speaking nonsense at the wire level, and
 * telling an operator the wrong one sends them to the wrong side of the link.
 */
function auditEventLabel(payload: { event?: unknown } | null): string {
	if (payload === null) return 'unparseable';
	return clampAuditField(payload.event) ?? 'missing-event';
}

/**
 * Write the bounded audit row for one raw-route delivery. Never fails the
 * webhook — mail that arrived is not dropped because its audit row would not
 * write — but it SAYS so when it could not write, because an audit that can
 * fail invisibly is worse than no audit at all.
 *
 * `envelope` is the route's own identifiers, already clamped by the caller with
 * `clampAuditField`/`base64ByteLength`; everything common to both routes
 * (version, event label, body size, body digest, unparseable-body head) is
 * added here so the two rows stay the same shape.
 */
export async function storeRawRouteAudit(
	ctx: ActionCtx,
	opts: {
		source: 'mta-mailbox' | 'mta-inbound';
		logTag: string;
		bodyText: string;
		payload: { event?: unknown } | null;
		envelope: Record<string, string | number | boolean | undefined>;
	}
): Promise<void> {
	try {
		const summary = {
			version: AUDIT_SUMMARY_VERSION,
			event: auditEventLabel(opts.payload),
			bodyChars: opts.bodyText.length,
			bodySha256: await sha256Hex(opts.bodyText),
			...opts.envelope,
			// A body we could not parse has no envelope fields to summarise, so the
			// row would be a digest of bytes nobody can read — proof only that we
			// could not read them either. Keep a bounded head of the garbage: it is
			// the whole reason anyone opens THIS row. A parseable body keeps none,
			// because on these routes the body IS the message.
			...(opts.payload === null ? { head: clampAuditField(opts.bodyText) } : {}),
		};
		await ctx.runMutation(internal.webhooks.payloads.store, {
			source: opts.source,
			rawPayload: JSON.stringify(summary),
		});
	} catch (error) {
		logError(`${opts.logTag} Failed to store the delivery audit row:`, error);
	}
}

/**
 * Everything that has to be true before a raw-route body is worth parsing:
 * method, per-source rate limit, a configured secret, both signature headers,
 * a readable body, and a valid HMAC inside the staleness window.
 *
 * Returns the verified body, or the exact `Response` to answer with. The body
 * read is UNBOUNDED, which is the whole reason these routes exist outside the
 * pipeline — see either route's header.
 */
export async function readVerifiedMtaBody(
	ctx: ActionCtx,
	request: Request,
	opts: { logTag: string; rateLimitKeyPrefix: 'mta-mailbox' | 'mta-inbound' }
): Promise<{ ok: true; bodyText: string } | { ok: false; response: Response }> {
	if (request.method !== 'POST') {
		return { ok: false, response: jsonResponse(405, { error: 'Method not allowed' }) };
	}

	// Per-source rate-limit key (`<route>:<ip>`) so a flood on one raw route
	// cannot drain the shared 'webhookIngestion' bucket and 429 the provider
	// bounce/complaint webhooks. Coarse by design: `getClientIp` returns
	// 'unknown' for every caller unless RATE_LIMIT_TRUSTED_PROXY is set, so on a
	// default deployment this is one shared bucket. The real spend control is
	// the per-sender attachment budget charged at the capture site, not this.
	const ip = getClientIp(request);
	const { ok, retryAfter } = await ctx.runMutation(internal.publicRateLimit.checkPublicRateLimit, {
		limitType: 'webhookIngestion',
		key: `${opts.rateLimitKeyPrefix}:${ip}`,
	});
	if (!ok) {
		return { ok: false, response: rateLimitedResponse(retryAfter) };
	}

	const secret = getOptional('MTA_WEBHOOK_SECRET');
	if (!secret) {
		logError(`${opts.logTag} MTA_WEBHOOK_SECRET is not configured`);
		return { ok: false, response: jsonResponse(503, { error: 'Webhook endpoint not configured' }) };
	}

	const signature = request.headers.get('x-mta-signature');
	const mtaTimestamp = request.headers.get('x-mta-timestamp');
	if (!signature || !mtaTimestamp) {
		logError(`${opts.logTag} Missing X-MTA-Signature or X-MTA-Timestamp`);
		return { ok: false, response: jsonResponse(401, { error: 'Missing signature headers' }) };
	}

	let bodyText: string;
	try {
		bodyText = await request.text();
	} catch {
		return { ok: false, response: jsonResponse(400, { error: 'Failed to read request body' }) };
	}

	// HMAC-SHA256 over `${timestamp}.${body}` + the 5-minute timestamp-staleness
	// check, shared with the main MTA webhook (`./mta.ts`) so the three inbound
	// paths can never drift on the signature scheme.
	if (!(await verifyMtaHeaders(bodyText, signature, mtaTimestamp, secret))) {
		logError(`${opts.logTag} Invalid signature or stale timestamp`);
		return { ok: false, response: jsonResponse(401, { error: 'Invalid signature' }) };
	}

	return { ok: true, bodyText };
}
