/**
 * HMAC-signed inbound webhook for DMARC aggregate reports (RFC 7489 §7.2).
 *
 * Endpoint: POST /webhooks/mta-dmarc-report
 *
 * The MTA treats Owlat's DMARC report address as a *system* inbound route
 * (`apps/mta/src/inbound/router.ts`) that delivers here, never to a mailbox.
 * The body is the MTA endpoint-forward payload; we pick the report attachment
 * (gzip, zip or XML) and hand it to the `'use node'` action
 * `domains/dmarcReportsNode.ts:decodeAndIngest`, which needs `node:zlib`.
 *
 * Auth is the MTA request signature every MTA route verifies
 * (`webhooks/mtaSignature.ts`) within the 60s request window. A bad, oversized
 * or irrelevant report is acknowledged with a 2xx and dropped, so the MTA does
 * not retry a report that will never parse.
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
import { readStreamBytes, StreamByteLimitExceeded } from '@owlat/shared';
import { DMARC_REPORT_MAX_XML_BYTES } from '@owlat/shared/dmarcReport';

// One base64 attachment of at most the plain-XML ceiling, plus the forwarded
// message's other fields (a report mail's body is a line or two).
const DMARC_REPORT_MAX_WEBHOOK_BODY_BYTES =
	4 * Math.ceil(DMARC_REPORT_MAX_XML_BYTES / 3) + 256 * 1024;

interface ForwardedAttachment {
	filename?: string;
	contentType?: string;
	content?: string; // base64
}

/** Report attachments by media type or name; the Node action checks the bytes. */
export function isDmarcReportAttachment(att: ForwardedAttachment): boolean {
	const type = (att.contentType ?? '').toLowerCase();
	const name = (att.filename ?? '').toLowerCase();
	return (
		type.includes('zip') ||
		type.includes('gzip') ||
		type.includes('xml') ||
		name.endsWith('.zip') ||
		name.endsWith('.gz') ||
		name.endsWith('.xml')
	);
}

export const handleDmarcReportWebhook = httpAction(async (ctx, request) => {
	if (request.method !== 'POST') {
		return methodNotAllowed();
	}

	const secret = getOptional('MTA_WEBHOOK_SECRET');
	if (!secret) {
		logError('[mta-dmarc-report] MTA_WEBHOOK_SECRET not configured');
		return errorResponse('network', 'Endpoint not configured');
	}

	const signatureWindow = { toleranceSeconds: MTA_REQUEST_TOLERANCE_SECONDS };
	const headers = readMtaSignatureHeaders(request, signatureWindow);
	if (!headers.ok) {
		return headers.reason === 'missing_headers'
			? errorResponse('unauthenticated', 'Missing signature')
			: errorResponse('unauthenticated', 'Stale timestamp');
	}

	const declaredLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > DMARC_REPORT_MAX_WEBHOOK_BODY_BYTES) {
		return jsonResponse({ ok: false, reason: 'payload-too-large' });
	}
	let bodyBytes: Uint8Array | null;
	try {
		bodyBytes = await readStreamBytes(request.body, DMARC_REPORT_MAX_WEBHOOK_BODY_BYTES);
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

	// Charged only after the signature checks out, like the TLS report webhook.
	const rateIp = getClientIp(request);
	const { ok: rateOk, retryAfter } = await ctx.runMutation(
		internal.lib.publicRateLimit.checkPublicRateLimit,
		{ limitType: 'webhookIngestion', key: `mta-dmarc-report:${rateIp}` }
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

	const attachment = (Array.isArray(payload.attachments) ? payload.attachments : []).find(
		isDmarcReportAttachment
	);
	if (typeof attachment?.content !== 'string' || attachment.content.length === 0) {
		return jsonResponse({ ok: false, reason: 'no-report-attachment' });
	}

	const result = await ctx.runAction(internal.domains.dmarcReportsNode.decodeAndIngest, {
		contentBase64: attachment.content,
	});
	return jsonResponse(result);
});
