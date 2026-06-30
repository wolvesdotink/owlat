/**
 * HMAC-signed credential verification endpoint for the MTA / IMAP server.
 *
 * Endpoint: POST /webhooks/mta-verify-credential
 * Body:    { address, password, scope: 'imap' | 'smtp' }
 * Returns: { ok: true, mailboxId, appPasswordId, organizationId, userId } | { ok: false }
 *
 * Uses the same MTA_WEBHOOK_SECRET HMAC pattern as mtaWebhook so we don't
 * have to ship the Convex admin key to the MTA.
 */

import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { logError } from '../lib/runtimeLog';
import { getOptional } from '../lib/env';
import { constantTimeEqual } from '../webhooks/security';
import { getClientIp } from '../publicRateLimit';

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
		internal.publicRateLimit.checkPublicRateLimit,
		{ limitType: 'webhookIngestion', key: `mta-verify-credential:${rateIp}` },
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

	const signature = request.headers.get('x-mta-signature');
	const timestamp = request.headers.get('x-mta-timestamp');
	if (!signature || !timestamp) {
		return new Response(JSON.stringify({ error: 'Missing signature' }), {
			status: 401,
		});
	}

	const ts = parseInt(timestamp, 10);
	const now = Math.floor(Date.now() / 1000);
	if (Number.isNaN(ts) || Math.abs(now - ts) > 60) {
		return new Response(JSON.stringify({ error: 'Stale timestamp' }), {
			status: 401,
		});
	}

	const bodyText = await request.text();

	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${bodyText}`));
	const expected = Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	if (!constantTimeEqual(signature, expected)) {
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
	};
	try {
		payload = JSON.parse(bodyText);
	} catch {
		return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
	}

	if (!payload.address || !payload.password || !payload.scope) {
		return new Response(JSON.stringify({ error: 'Missing fields' }), { status: 400 });
	}

	const clientIp = getClientIp(request);
	const result = await ctx.runAction(internal.mail.appPasswords.verify, {
		address: payload.address,
		password: payload.password,
		scope: payload.scope,
		// Engage verify's per-IP auth-failure throttle (getClientIp already
		// honors RATE_LIMIT_TRUSTED_PROXY); without this the throttle was dead
		// from its only caller.
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
