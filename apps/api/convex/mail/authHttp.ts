import { BodyTooLargeError, readBodyText } from '../lib/readBody';
/**
 * HMAC-signed credential verification endpoint for the MTA / IMAP server.
 *
 * Endpoint: POST /webhooks/mta-verify-credential
 * Body:    { address, password, scope: 'imap' | 'smtp', clientName?, ip? }
 * Returns: { ok: true, mailboxId, appPasswordId, organizationId, userId } | { ok: false }
 *
 * Authenticated with the MTA request signature every MTA route verifies
 * (`webhooks/mtaSignature.ts`, MTA_WEBHOOK_SECRET, 60s request window) so we
 * don't have to ship the Convex admin key to the MTA.
 */

import { v } from 'convex/values';
import { decodeJsonText } from '@owlat/worker-protocol/decodeJson';
import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { logError } from '../lib/runtimeLog';
import { getOptional } from '../lib/env';
import {
	MTA_REQUEST_TOLERANCE_SECONDS,
	readMtaSignatureHeaders,
	verifyMtaSignedRequest,
} from '../webhooks/mtaSignature';
import { getClientIp } from '../lib/publicRateLimit';
import { ipRateLimitKey, normalizePeerIp } from '@owlat/shared/ipAddress';

/**
 * Every field is optional on the wire: presence is the handler's check, after
 * the rate limit, so a body missing a field still counts against the limit
 * and answers `Missing fields`.
 */
const verifyCredentialBody = v.object({
	address: v.optional(v.string()),
	password: v.optional(v.string()),
	scope: v.optional(v.union(v.literal('imap'), v.literal('smtp'))),
	// Optional client identifier (e.g. the SMTP EHLO hostname) the MTA forwards
	// so successful submissions populate the app-password "Last used"
	// device/client column, mirroring the IMAP ID path.
	clientName: v.optional(v.string()),
	// The submission client's address as the MTA saw it on the socket. The HTTP
	// caller here is the MTA itself, so the request's own source address says
	// nothing about which client is logging in. An MTA that predates the field,
	// or sends one that is not an address, falls back to the request source.
	ip: v.optional(v.any()),
});

export const handleVerifyCredential = httpAction(async (ctx, request) => {
	if (request.method !== 'POST') {
		return new Response(JSON.stringify({ error: 'Method not allowed' }), {
			status: 405,
		});
	}

	const secret = getOptional('MTA_WEBHOOK_SECRET');
	if (!secret) {
		logError('[mta-verify-credential] MTA_WEBHOOK_SECRET not configured');
		return new Response(JSON.stringify({ error: 'Endpoint not configured' }), {
			status: 503,
		});
	}

	// Refuse a missing, malformed or stale header pair before reading the body.
	const signatureWindow = { toleranceSeconds: MTA_REQUEST_TOLERANCE_SECONDS };
	const headers = readMtaSignatureHeaders(request, signatureWindow);
	if (!headers.ok) {
		const error = headers.reason === 'missing_headers' ? 'Missing signature' : 'Stale timestamp';
		return new Response(JSON.stringify({ error }), { status: 401 });
	}

	let bodyText: string;
	try {
		bodyText = await readBodyText(request, 100_000);
	} catch (error) {
		return new Response(
			error instanceof BodyTooLargeError ? 'Payload too large' : 'Unreadable body',
			{
				status: error instanceof BodyTooLargeError ? 413 : 400,
			}
		);
	}

	const verdict = await verifyMtaSignedRequest(request, bodyText, { ...signatureWindow, secret });
	if (!verdict.ok) {
		return new Response(JSON.stringify({ error: 'Invalid signature' }), {
			status: 401,
		});
	}

	const decoded = decodeJsonText(bodyText, verifyCredentialBody);
	if (!decoded.ok) {
		return new Response(JSON.stringify({ error: decoded.failure.message }), { status: 400 });
	}
	const payload = decoded.value;

	// Key verify's per-IP auth-failure throttle on the client the MTA reports in
	// the signed body. A body without a usable ip comes from an MTA that predates
	// the field (a rolling upgrade), which falls back to the request source.
	const clientIp =
		(typeof payload.ip === 'string' ? normalizePeerIp(payload.ip) : null) ?? getClientIp(request);

	// The ingestion bucket is charged only after the signature check, so only
	// the MTA can spend it, and it is keyed on the same signed client IP (an IPv6
	// client per /64). Keyed on the request source instead, every login would
	// share the MTA's one bucket: a burst of checks for other clients would 429 a
	// legitimate login, and the MTA counts that as the client's auth failure. The
	// per-client bucket still bounds how many checks one client can cause.
	const { ok: rateOk, retryAfter } = await ctx.runMutation(
		internal.lib.publicRateLimit.checkPublicRateLimit,
		{ limitType: 'webhookIngestion', key: `mta-verify-credential:${ipRateLimitKey(clientIp)}` }
	);
	if (!rateOk) {
		return new Response(JSON.stringify({ error: 'Rate limited' }), {
			status: 429,
			headers: retryAfter ? { 'Retry-After': String(Math.ceil(retryAfter / 1000)) } : {},
		});
	}

	if (!payload.address || !payload.password || !payload.scope) {
		return new Response(JSON.stringify({ error: 'Missing fields' }), { status: 400 });
	}
	const result = await ctx.runAction(internal.mail.appPasswords.verify, {
		address: payload.address,
		password: payload.password,
		scope: payload.scope,
		ip: clientIp,
	});

	if (!result) {
		return new Response(JSON.stringify({ ok: false }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	// Record last-used activity for the SMTP submission path (the IMAP server
	// touches directly via its admin client; SMTP goes through this webhook).
	// `channel` tells touch this is not a login through an IMAP server too old
	// to report its version. Best-effort — never block or fail the auth
	// response on it.
	const clientName = payload.clientName?.trim().slice(0, 120);
	await ctx
		.runMutation(internal.mail.appPasswords.touch, {
			appPasswordId: result.appPasswordId,
			ip: clientIp,
			...(clientName ? { userAgent: clientName } : {}),
			channel: 'smtp',
		})
		.catch(() => undefined);
	return new Response(
		JSON.stringify({
			ok: true,
			mailboxId: result.mailboxId,
			appPasswordId: result.appPasswordId,
			userId: result.userId,
			organizationId: result.organizationId,
		}),
		{
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		}
	);
});
