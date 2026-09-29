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
 * Auth is the MTA request signature every MTA route verifies
 * (`webhooks/mtaSignature.ts`): the `MTA_WEBHOOK_SECRET` HMAC over
 * `${timestamp}.${body}`, here with the 60s request window, so a spoofed report
 * cannot pollute the operator's TLS telemetry.
 *
 * Malformed / oversized / unsigned-attachment reports are rejected **without
 * throwing** — the handler always returns a 2xx so the MTA does not retry a
 * permanently-bad report, but it never ingests garbage.
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
import { errorResponse, jsonResponse, methodNotAllowed } from '../lib/httpResponse';
import {
	readStreamBytes,
	StreamByteLimitExceeded,
	TLS_RPT_MAX_DECOMPRESSED_BYTES,
} from '@owlat/shared';

// The webhook JSON wraps one base64 attachment. Allow the full plain-JSON
// report ceiling plus bounded envelope metadata, and stop reading immediately
// when an unauthenticated sender exceeds it.
const TLS_RPT_MAX_WEBHOOK_BODY_BYTES =
	4 * Math.ceil(TLS_RPT_MAX_DECOMPRESSED_BYTES / 3) + 64 * 1024;

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
		return methodNotAllowed();
	}

	const secret = getOptional('MTA_WEBHOOK_SECRET');
	if (!secret) {
		logError('[mta-tls-report] MTA_WEBHOOK_SECRET not configured');
		return errorResponse('network', 'Endpoint not configured');
	}

	// Refuse a missing, malformed or stale header pair before reading the body.
	const signatureWindow = { toleranceSeconds: MTA_REQUEST_TOLERANCE_SECONDS };
	const headers = readMtaSignatureHeaders(request, signatureWindow);
	if (!headers.ok) {
		return headers.reason === 'missing_headers'
			? errorResponse('unauthenticated', 'Missing signature')
			: errorResponse('unauthenticated', 'Stale timestamp');
	}

	const declaredLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > TLS_RPT_MAX_WEBHOOK_BODY_BYTES) {
		return jsonResponse({ ok: false, reason: 'payload-too-large' });
	}
	let bodyBytes: Uint8Array | null;
	try {
		bodyBytes = await readStreamBytes(request.body, TLS_RPT_MAX_WEBHOOK_BODY_BYTES);
	} catch (error) {
		if (error instanceof StreamByteLimitExceeded) {
			return jsonResponse({ ok: false, reason: 'payload-too-large' });
		}
		throw error;
	}
	const bodyText = bodyBytes ? new TextDecoder().decode(bodyBytes) : '';
	const verdict = await verifyMtaSignedRequest(request, bodyText, { ...signatureWindow, secret });
	if (!verdict.ok) {
		return errorResponse('unauthenticated', 'Invalid signature');
	}

	// Charged only once the signature checks out (the body is capped above), so
	// unsigned requests never spend the MTA's ingestion budget.
	const rateIp = getClientIp(request);
	const { ok: rateOk, retryAfter } = await ctx.runMutation(
		internal.lib.publicRateLimit.checkPublicRateLimit,
		{ limitType: 'webhookIngestion', key: `mta-tls-report:${rateIp}` }
	);
	if (!rateOk) {
		return errorResponse(
			'rate_limited',
			'Rate limited',
			retryAfter === undefined ? undefined : { retryAfter },
			retryAfter ? { 'Retry-After': String(Math.ceil(retryAfter / 1000)) } : null
		);
	}

	let payload: { attachments?: ForwardedAttachment[] };
	try {
		payload = JSON.parse(bodyText);
	} catch {
		return errorResponse('invalid_input', 'Invalid JSON');
	}

	const attachment = (payload.attachments ?? []).find(isTlsReportAttachment);
	if (!attachment?.content) {
		// No report attachment — acknowledge without ingesting (do not retry).
		return jsonResponse({ ok: false, reason: 'no-report-attachment' });
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
		return jsonResponse({ ok: false, reason: result.reason });
	}

	return jsonResponse({ ok: true, deduped: result.deduped });
});
