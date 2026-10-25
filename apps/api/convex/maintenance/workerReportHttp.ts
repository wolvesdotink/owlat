/**
 * The MTA's wire-version report (`maintenance/workerRegistry.ts`).
 *
 * Endpoint: POST /webhooks/mta-worker-report
 * Body:    { instanceId, hostLabel, owlatVersion, wireVersion, startedAt }
 * Returns: the backend's side of the MTA contract (`WorkerWireReportResult`).
 *
 * The MTA holds no Convex key, so it reports over the request signature every
 * MTA route verifies (`webhooks/mtaSignature.ts`, `MTA_WEBHOOK_SECRET`, the
 * 60 s request window), like `/webhooks/mta-verify-credential`. Every replica
 * reports for itself; the body names only that replica's process.
 */

import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { logError } from '../lib/runtimeLog';
import { getOptional } from '../lib/env';
import { isRecord } from '@owlat/shared';
import {
	MTA_REQUEST_TOLERANCE_SECONDS,
	readMtaSignatureHeaders,
	verifyMtaSignedRequest,
} from '../webhooks/mtaSignature';
import { BodyTooLargeError, readBodyText } from '../lib/readBody';
import { jsonResponse } from '../lib/httpResponse';
import type { WorkerReport } from './workerRegistry';

/** Three short labels and two numbers. */
const MAX_BODY_BYTES = 4 * 1024;

/** The report fields with their types checked; anything else is ignored. */
function parseWorkerReport(payload: unknown): WorkerReport | null {
	if (!isRecord(payload)) return null;
	const { instanceId, hostLabel, owlatVersion, wireVersion, startedAt } = payload;
	if (
		typeof instanceId !== 'string' ||
		typeof hostLabel !== 'string' ||
		typeof owlatVersion !== 'string' ||
		typeof wireVersion !== 'number' ||
		!Number.isSafeInteger(wireVersion) ||
		wireVersion < 0 ||
		typeof startedAt !== 'number' ||
		!Number.isFinite(startedAt)
	) {
		return null;
	}
	return { instanceId, hostLabel, owlatVersion, wireVersion, startedAt };
}

export const handleMtaWorkerReport = httpAction(async (ctx, request) => {
	if (request.method !== 'POST') {
		return jsonResponse({ error: 'Method not allowed' }, 405);
	}

	const secret = getOptional('MTA_WEBHOOK_SECRET');
	if (!secret) {
		logError('[mta-worker-report] MTA_WEBHOOK_SECRET not configured');
		return jsonResponse({ error: 'Endpoint not configured' }, 503);
	}

	// Refuse a missing, malformed or stale header pair before reading the body.
	const signatureWindow = { toleranceSeconds: MTA_REQUEST_TOLERANCE_SECONDS };
	const headers = readMtaSignatureHeaders(request, signatureWindow);
	if (!headers.ok) {
		const error = headers.reason === 'missing_headers' ? 'Missing signature' : 'Stale timestamp';
		return jsonResponse({ error }, 401);
	}

	let bodyText: string;
	try {
		bodyText = await readBodyText(request, MAX_BODY_BYTES);
	} catch (error) {
		return error instanceof BodyTooLargeError
			? jsonResponse({ error: 'Payload too large' }, 413)
			: jsonResponse({ error: 'Unreadable body' }, 400);
	}

	const verdict = await verifyMtaSignedRequest(request, bodyText, { ...signatureWindow, secret });
	if (!verdict.ok) return jsonResponse({ error: 'Invalid signature' }, 401);

	let payload: unknown;
	try {
		payload = JSON.parse(bodyText);
	} catch {
		return jsonResponse({ error: 'Invalid JSON' }, 400);
	}
	const report = parseWorkerReport(payload);
	if (!report) return jsonResponse({ error: 'Invalid report' }, 400);

	const result = await ctx.runMutation(internal.maintenance.workerRegistry.report, {
		service: 'mta',
		...report,
	});
	return jsonResponse(result);
});
