import { BodyTooLargeError, readBodyText } from '../../lib/readBody';
/**
 * The shared middle of the two MTA routes whose body IS the message.
 *
 * `POST /webhooks/mta-mailbox` (`mail/webhookHttp.ts`) and
 * `POST /webhooks/mta-inbound` (`inbox/inboundWebhookHttp.ts`) both stand
 * outside `webhooks/pipeline.ts` for the same reason — the pipeline caps a
 * request body at `MAX_WEBHOOK_BODY_BYTES` before authenticating it, and these
 * two carry whole messages — so the pipeline's preamble lives HERE instead: the
 * per-source rate limit, the secret lookup, the header check, the body read,
 * the shared HMAC + staleness verification, and a bounded digest-not-a-copy
 * audit row.
 *
 * The next audit-shape bump, header rename or staleness change therefore lands
 * once, and neither route can silently keep the old one. What stays in each
 * route file is what genuinely differs: its payload interface, its event check,
 * the envelope fields it summarises, and the action it dispatches into.
 */

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { getClientIp, rateLimitedResponse } from '../../publicRateLimit';
import { logError } from '../../lib/runtimeLog';
import { getOptional } from '../../lib/env';
import { verifyMtaHeaders } from './mta';
import { jsonResponse } from '../inboundHttp';

/**
 * Which of the two raw routes is calling — the audit row's `source` and the
 * rate-limit key both take it, and a third route means adding it here once.
 */
export type RawRouteSource = 'mta-mailbox' | 'mta-inbound';

/**
 * A verified body, or the exact `Response` to answer with instead.
 *
 * Named because `readVerifiedMtaBody` and the inner read-and-verify it wraps
 * are the same answer twice, and the union was spelled out at both.
 */
export type VerifiedMtaBody = { ok: true; bodyText: string } | { ok: false; response: Response };

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
const AUDIT_SUMMARY_VERSION = 1;

// The MTA accepts at most 10 MiB of raw mail. This leaves headroom for base64,
// parsed bodies and JSON escaping while bounding unauthenticated wire bytes.
const MAX_RAW_WEBHOOK_BYTES = 64 * 1024 * 1024;

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
		source: RawRouteSource;
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
 * Bodies at or under this declared size are HMAC-verified BEFORE the shared
 * rate-limit bucket is charged.
 *
 * WHY A BOUND AT ALL. Verifying first is what keeps unsigned traffic from
 * spending the bucket — but verifying means READING the body, and on a route
 * that accepts a 13 MiB base64 message that read is the cost an unauthenticated
 * caller must not be able to impose at will. So the free verification is
 * offered only to a caller whose own `Content-Length` says the body is small;
 * anything bigger pays the bucket first, exactly as before. A caller that lies
 * about its length is reading a body no bigger than the route already accepts
 * from a signed one, and it pays the bucket on the very next request.
 *
 * 256 KiB comfortably covers every signature probe, every health check and
 * every hand-rolled junk POST — the traffic this exists to keep off the bucket.
 */
const FREE_VERIFY_BYTES = 256 * 1024;

/**
 * Does this request's own `Content-Length` declare a body at or under `limit`?
 *
 * Strict about the header itself: absent (a chunked body declares nothing),
 * empty, negative or not a number all answer `false`, because the free body
 * read below is offered on the strength of that number alone.
 */
function declaresBodyUnder(request: Request, limit: number): boolean {
	const raw = request.headers.get('content-length');
	if (raw === null || raw.trim() === '') return false;
	const declared = Number(raw);
	return Number.isFinite(declared) && declared >= 0 && declared <= limit;
}

/**
 * Everything that has to be true before a raw-route body is worth parsing:
 * method, both signature headers, a configured secret, a readable body, a valid
 * HMAC inside the staleness window, and the per-source rate limit — ordered so
 * the checks that cost nothing run before the ones that spend a shared bucket
 * or read an unbounded body.
 *
 * WHERE THE BUCKET SITS IS THE POINT. Without `RATE_LIMIT_TRUSTED_PROXY` every
 * caller keys as `unknown`, so the bucket is ONE bucket shared with the real
 * MTA — and anything an unauthenticated caller can charge to it 429s the next
 * genuine delivery, which the MTA reads as retryable: six attempts, then the
 * DLQ. Refusing a request without both signature headers costs one header
 * lookup and charges nothing; refusing a SMALL request whose signature does not
 * verify costs one read and one HMAC and also charges nothing. Only a body too
 * big to verify for free, and every verified request, reaches the bucket.
 *
 * Returns the verified body, or the exact `Response` to answer with. The body
 * budget is larger than the feedback pipeline's because these routes carry
 * complete messages, but is enforced while reading even before authentication.
 */
export async function readVerifiedMtaBody(
	ctx: ActionCtx,
	request: Request,
	opts: { logTag: string; rateLimitKeyPrefix: RawRouteSource }
): Promise<VerifiedMtaBody> {
	if (request.method !== 'POST') {
		return { ok: false, response: jsonResponse(405, { error: 'Method not allowed' }) };
	}

	// Both signature headers are a string comparison against no state at all.
	const signature = request.headers.get('x-mta-signature');
	const mtaTimestamp = request.headers.get('x-mta-timestamp');
	if (!signature || !mtaTimestamp) {
		logError(`${opts.logTag} Missing X-MTA-Signature or X-MTA-Timestamp`);
		return { ok: false, response: jsonResponse(401, { error: 'Missing signature headers' }) };
	}

	const secret = getOptional('MTA_WEBHOOK_SECRET');
	if (!secret) {
		logError(`${opts.logTag} MTA_WEBHOOK_SECRET is not configured`);
		return { ok: false, response: jsonResponse(503, { error: 'Webhook endpoint not configured' }) };
	}

	/**
	 * Read the body and check the HMAC-SHA256 over `${timestamp}.${body}` plus
	 * the 5-minute staleness window — shared with the main MTA webhook
	 * (`./mta.ts`) so the three inbound paths can never drift on the scheme.
	 */
	const readAndVerify = async (): Promise<VerifiedMtaBody> => {
		let bodyText: string;
		try {
			bodyText = await readBodyText(request, MAX_RAW_WEBHOOK_BYTES);
		} catch (error) {
			if (error instanceof BodyTooLargeError) {
				return { ok: false, response: jsonResponse(413, { error: 'Payload too large' }) };
			}
			return { ok: false, response: jsonResponse(400, { error: 'Failed to read request body' }) };
		}
		if (!(await verifyMtaHeaders(bodyText, signature, mtaTimestamp, secret))) {
			logError(`${opts.logTag} Invalid signature or stale timestamp`);
			return { ok: false, response: jsonResponse(401, { error: 'Invalid signature' }) };
		}
		return { ok: true, bodyText };
	};

	// A caller whose own Content-Length says the body is small is verified for
	// free, so junk that merely CARRIES the two headers cannot spend the bucket
	// either. The headers being present was never evidence of anything.
	//
	// NO LENGTH IS NOT A SMALL LENGTH. A chunked request declares none, and
	// `Number(null)` is 0 — which would have handed any caller who simply omits
	// the header an unbounded free read, a bigger hole than the one this closes.
	// Absent, empty or unparseable: pay the bucket first.
	const verified = declaresBodyUnder(request, FREE_VERIFY_BYTES) ? await readAndVerify() : null;
	if (verified && !verified.ok) return verified;

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

	return verified ?? (await readAndVerify());
}
