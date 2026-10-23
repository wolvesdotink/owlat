/**
 * The code-worker's wire-version report: once at startup and every
 * {@link WIRE_REPORT_INTERVAL_MS} after, so the backend can show version skew
 * and hold contract steps until every worker has moved. The answer is only
 * logged; the worker keeps polling either way.
 *
 * `@owlat/shared/workerWireReporter` does the same for mail-sync and the MTA;
 * this image does not ship that package, hence the small copy here.
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { owlatVersion } from './config.js';
import {
	getConvexClient,
	wireFn,
	type CodeWorkerWireReport,
	type CodeWorkerWireReportResult,
} from './convexClient.js';
import { log as defaultLog } from './log.js';
import { CODE_WORKER_WIRE_VERSION } from './wireVersion.js';

/** Same cadence as every other worker (`WORKER_REPORT_INTERVAL_MS`). */
export const WIRE_REPORT_INTERVAL_MS = 5 * 60_000;

type TimerHandle = { unref?: () => unknown };

export interface WireReportOptions {
	report?: (report: CodeWorkerWireReport) => Promise<CodeWorkerWireReportResult>;
	log?: (message: string) => void;
	now?: () => number;
	setInterval?: (callback: () => void, ms: number) => TimerHandle;
	clearInterval?: (handle: TimerHandle) => void;
}

/** What is wrong with this worker's contract per the backend's answer; null when it is served. */
export function describeWireReport(
	result: CodeWorkerWireReportResult,
	wireVersion: number = CODE_WORKER_WIRE_VERSION
): string | null {
	if (wireVersion > result.backendWireVersion) {
		return (
			`This code-worker (wire version ${wireVersion}) is newer than the backend ` +
			`(wire version ${result.backendWireVersion}). Update the backend first; it may also be mid-deploy.`
		);
	}
	if (wireVersion < result.minSupportedWireVersion || !result.compatible) {
		return (
			`This code-worker (wire version ${wireVersion}) is older than the backend supports ` +
			`(wire version ${result.minSupportedWireVersion} or newer). Update the code-worker image.`
		);
	}
	return null;
}

export function startWireReports(options: WireReportOptions = {}): { stop: () => void } {
	const log = options.log ?? defaultLog;
	const report = options.report ?? ((args) => getConvexClient().mutation(wireFn.report, args));
	const set = options.setInterval ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
	const clear =
		options.clearInterval ?? ((handle: TimerHandle) => clearInterval(handle as NodeJS.Timeout));
	const identity: CodeWorkerWireReport = {
		instanceId: randomUUID(),
		hostLabel: hostname(),
		owlatVersion: owlatVersion(),
		wireVersion: CODE_WORKER_WIRE_VERSION,
		startedAt: (options.now ?? Date.now)(),
	};
	let stopped = false;
	let inFlight = false;

	const tick = async () => {
		if (stopped || inFlight) return;
		inFlight = true;
		try {
			const problem = describeWireReport(await report(identity), identity.wireVersion);
			if (problem && !stopped) log(problem);
		} catch (error) {
			if (!stopped) {
				const message = error instanceof Error ? error.message : String(error);
				log(
					`Could not report the wire version to the backend; retrying at the next report: ${message}`
				);
			}
		} finally {
			inFlight = false;
		}
	};

	const handle = set(() => void tick(), WIRE_REPORT_INTERVAL_MS);
	handle.unref?.();
	void tick();
	return {
		stop: () => {
			if (stopped) return;
			stopped = true;
			clear(handle);
		},
	};
}
