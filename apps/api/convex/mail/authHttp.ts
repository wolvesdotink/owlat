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
import { normalizePeerIp } from '@owlat/shared/ipAddress';

export const handleVerifyCredential = httpAction(async (ctx, request) => {
	if (request.method !== 'POST') {
		return new Response(JSON.stringify({ error: 'Method not allowed' }), {
			status: 405,
		});
	}

	// Same ingestion bucket as the other inbound webhooks (this was the only
	// one without a rate-limit gate). Keyed per-source like webhooks/pipeline
	// so a flood here cannot drain the bounce/complaint buckets.
	const rateIp = getClientIp(request);
	const { ok: rateOk, retryAfter } = await ctx.runMutation(
		internal.lib.publicRateLimit.checkPublicRateLimit,
		{ limitType: 'webhookIngestion', key: `mta-verify-credential:${rateIp}` }
	);
	if (!rateOk) {
		return new Response(JSON.stringify({ error: 'Rate limited' }), {
			status: 429,
			headers: retryAfter ? { 'Retry-After': String(Math.ceil(retryAfter / 1000)) } : {},
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

	let payload: {
		address?: string;
		password?: string;
		scope?: 'imap' | 'smtp';
		// Optional client identifier (e.g. the SMTP EHLO hostname) the MTA
		// forwards so successful submissions populate the app-password
		// "Last used" device/client column, mirroring the IMAP ID path.
		clientName?: string;
		// The submission client's address as the MTA saw it on the socket. The
		// HTTP caller here is the MTA itself, so the request's own source address
		// says nothing about which client is logging in.
		ip?: unknown;
	};
	try {
		payload = JSON.parse(bodyText);
	} catch {
		return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
	}

	if (!payload.address || !payload.password || !payload.scope) {
		return new Response(JSON.stringify({ error: 'Missing fields' }), { status: 400 });
	}

	// Key verify's per-IP auth-failure throttle on the client the MTA reports in
	// the signed body. A body without a usable ip comes from an MTA that predates
	// the field (a rolling upgrade), which falls back to the request source.
	const clientIp =
		(typeof payload.ip === 'string' ? normalizePeerIp(payload.ip) : null) ?? getClientIp(request);
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
	// Best-effort — never block or fail the auth response on it.
	const clientName = payload.clientName?.trim().slice(0, 120);
	await ctx
		.runMutation(internal.mail.appPasswords.touch, {
			appPasswordId: result.appPasswordId,
			ip: clientIp,
			...(clientName ? { userAgent: clientName } : {}),
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
