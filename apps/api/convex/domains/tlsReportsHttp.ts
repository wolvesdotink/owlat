/**
 * HMAC-signed inbound webhook for SMTP TLS Reports (TLS-RPT, RFC 8460).
 *
 * Endpoint: POST /webhooks/mta-tls-report
 *
 * The MTA registers the operator's `_smtp._tls` `rua=` address as a *system*
 * inbound route (`apps/mta/src/inbound/router.ts`) that delivers here — a
 * dedicated webhook event, never a user mailbox. The forwarded body is the
 * MTA endpoint-forward payload; we locate the `application/tlsrpt+gzip`
 * attachment, gunzip + parse it with the shared never-throwing parser, and
 * idempotently persist the digest via `domains/tlsReports.ts:ingest`.
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
import { constantTimeEqual } from '../webhooks/security';
import { getClientIp } from '../publicRateLimit';
import { decodeTlsReport, parseTlsReport, digestTlsReport } from '@owlat/shared';

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
		ct === 'application/tlsrpt+gzip' ||
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

	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(atob(attachment.content), (c) => c.charCodeAt(0));
	} catch {
		return new Response(JSON.stringify({ ok: false, reason: 'bad-base64' }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	// Gzip attachments go through gunzip+parse; a plain `.json` is parsed directly.
	const isPlainJson = (attachment.filename ?? '').toLowerCase().endsWith('.json');
	const parsed = isPlainJson
		? parseTlsReport(new TextDecoder('utf-8').decode(bytes))
		: await decodeTlsReport(bytes);

	if (!parsed.ok) {
		// Rejected WITHOUT throwing — acknowledge so the MTA stops retrying.
		return new Response(JSON.stringify({ ok: false, reason: parsed.error }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const digest = digestTlsReport(parsed.report);
	const result = await ctx.runMutation(internal.domains.tlsReports.ingest, {
		reportId: digest.reportId,
		organizationName: digest.organizationName,
		contactInfo: digest.contactInfo,
		policyDomain: digest.policyDomain,
		rangeStartMs: digest.rangeStartMs,
		rangeEndMs: digest.rangeEndMs,
		successCount: digest.successCount,
		failureCount: digest.failureCount,
		failureTypeCounts: digest.failureTypeCounts,
	});

	return new Response(JSON.stringify({ ok: true, deduped: result.deduped }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
});
