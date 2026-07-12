/**
 * HMAC-signed inbound webhook for SMTP TLS Reports (TLS-RPT, RFC 8460).
 *
 * Endpoint: POST /webhooks/mta-tls-report
 *
 * The MTA registers the operator's `_smtp._tls` `rua=` address as a *system*
 * inbound route (`apps/mta/src/inbound/router.ts`) that delivers here — a
 * dedicated webhook event, never a user mailbox. The forwarded body is the
 * MTA endpoint-forward payload; we locate the `application/tlsrpt+gzip`
 * attachment and hand it to the `'use node'` action
 * `domains/tlsReportsNode.ts:decodeAndIngest`, which gunzips + parses it with
 * the shared never-throwing parser and idempotently persists the digest via
 * `domains/tlsReports.ts:ingest`. (The gunzip step uses `DecompressionStream`,
 * which is absent from Convex's default isolate runtime, so it must run in Node.)
 *
 * Auth mirrors the other MTA webhooks (`mta-verify-credential`): the same
 * `MTA_WEBHOOK_SECRET` HMAC over `${timestamp}.${body}` with a 60s freshness
 * window, so a spoofed report cannot pollute the operator's TLS telemetry.
 *
 * Malformed / oversized / unsigned-attachment reports are rejected **without
 * throwing** — the handler always returns a 2xx so the MTA does not retry a
 * permanently-bad report, but it never ingests garbage.
 */

import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { logError } from '../lib/runtimeLog';
import { getOptional } from '../lib/env';
import { constantTimeEqual, hmacSha256Hex } from '../webhooks/security';
import { getClientIp } from '../publicRateLimit';

interface ForwardedAttachment {
	filename?: string;
	contentType?: string;
	content?: string; // base64
}

function isTlsReportAttachment(att: ForwardedAttachment): boolean {
	const ct = (att.contentType ?? '').toLowerCase();
	const name = (att.filename ?? '').toLowerCase();
	return (
		ct.includes('tlsrpt') ||
		name.endsWith('.json.gz') ||
		name.endsWith('.gz') ||
		name.endsWith('.json')
	);
}

export const handleTlsReportWebhook = httpAction(async (ctx, request) => {
	if (request.method !== 'POST') {
		return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
	}

	const rateIp = getClientIp(request);
	const { ok: rateOk, retryAfter } = await ctx.runMutation(
		internal.publicRateLimit.checkPublicRateLimit,
		{ limitType: 'webhookIngestion', key: `mta-tls-report:${rateIp}` }
	);
	if (!rateOk) {
		return new Response(JSON.stringify({ error: 'Rate limited' }), {
			status: 429,
			headers: retryAfter ? { 'Retry-After': String(Math.ceil(retryAfter / 1000)) } : {},
		});
	}

	const secret = getOptional('MTA_WEBHOOK_SECRET');
	if (!secret) {
		logError('[mta-tls-report] MTA_WEBHOOK_SECRET not configured');
		return new Response(JSON.stringify({ error: 'Endpoint not configured' }), { status: 503 });
	}

	const signature = request.headers.get('x-mta-signature');
	const timestamp = request.headers.get('x-mta-timestamp');
	if (!signature || !timestamp) {
		return new Response(JSON.stringify({ error: 'Missing signature' }), { status: 401 });
	}
	const ts = parseInt(timestamp, 10);
	const now = Math.floor(Date.now() / 1000);
	if (Number.isNaN(ts) || Math.abs(now - ts) > 60) {
		return new Response(JSON.stringify({ error: 'Stale timestamp' }), { status: 401 });
	}

	const bodyText = await request.text();
	// Same HMAC scheme as the other MTA webhooks — reuse the shared helper rather
	// than re-inlining importKey + sign + hex-encode.
	const expected = await hmacSha256Hex(secret, `${timestamp}.${bodyText}`);
	if (!constantTimeEqual(signature, expected)) {
		return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });
	}

	let payload: { attachments?: ForwardedAttachment[] };
	try {
		payload = JSON.parse(bodyText);
	} catch {
		return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
	}

	const attachment = (payload.attachments ?? []).find(isTlsReportAttachment);
	if (!attachment?.content) {
		// No report attachment — acknowledge without ingesting (do not retry).
		return new Response(JSON.stringify({ ok: false, reason: 'no-report-attachment' }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	// The gunzip step (WHATWG DecompressionStream) is not in Convex's default
	// isolate runtime, so decode + validate + digest + ingest run in a `'use node'`
	// action. It never throws — a bad base64 / corrupt gzip / malformed report all
	// come back as `{ ok: false, reason }`, which we acknowledge (2xx) so the MTA
	// stops retrying a permanently-bad report.
	const isPlainJson = (attachment.filename ?? '').toLowerCase().endsWith('.json');
	const result = await ctx.runAction(internal.domains.tlsReportsNode.decodeAndIngest, {
		contentBase64: attachment.content,
		isPlainJson,
	});

	if (!result.ok) {
		return new Response(JSON.stringify({ ok: false, reason: result.reason }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	return new Response(JSON.stringify({ ok: true, deduped: result.deduped }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
});
