/**
 * The MTA's wire-version report to the backend.
 *
 * Every replica reports its own process at startup and every 5 minutes, to the
 * signed `/webhooks/mta-worker-report` route (the MTA holds no Convex key), so
 * the backend can show version skew and hold contract steps until every MTA
 * has moved. The answer is only logged: the MTA serves every backend inside
 * the skew window.
 */

import { signMtaRequest } from '@owlat/mta-protocol/signer';
import { isRecord } from '@owlat/shared';
import { workerWireWindow, type WorkerWireReportResult } from '@owlat/shared/workerWire';
import {
	startWorkerWireReports,
	workerReportIdentity,
	type WorkerReportIdentity,
} from '@owlat/shared/workerWireReporter';
import type { MtaConfig } from '../config.js';
import { logger } from './logger.js';

const TIMEOUT_MS = 10_000;

function parseReportResult(body: unknown): WorkerWireReportResult {
	if (
		!isRecord(body) ||
		typeof body['backendWireVersion'] !== 'number' ||
		typeof body['minSupportedWireVersion'] !== 'number' ||
		typeof body['compatible'] !== 'boolean'
	) {
		throw new Error('The backend answered the wire report with an unexpected body');
	}
	return {
		backendWireVersion: body['backendWireVersion'],
		minSupportedWireVersion: body['minSupportedWireVersion'],
		compatible: body['compatible'],
	};
}

/** One signed report; throws on a transport failure or a non-2xx answer. */
export async function sendMtaWireReport(
	config: Pick<MtaConfig, 'convexSiteUrl' | 'webhookSecret'>,
	report: WorkerReportIdentity & { wireVersion: number },
	fetchImpl: typeof fetch = fetch
): Promise<WorkerWireReportResult> {
	const body = JSON.stringify(report);
	const response = await fetchImpl(`${config.convexSiteUrl}/webhooks/mta-worker-report`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...signMtaRequest(config.webhookSecret, body) },
		body,
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) {
		// A backend from before the route answers 404; it is older than this MTA.
		throw new Error(`The backend answered the wire report with HTTP ${response.status}`);
	}
	return parseReportResult(await response.json());
}

export function startMtaWireReports(config: MtaConfig): { stop: () => void } {
	const identity = workerReportIdentity();
	const wireVersion = workerWireWindow('mta').current;
	return startWorkerWireReports({
		service: 'mta',
		wireVersion,
		owlatVersion: identity.owlatVersion,
		report: () => sendMtaWireReport(config, { ...identity, wireVersion }),
		log: logger,
	});
}
