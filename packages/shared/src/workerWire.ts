/**
 * The wire contract version of every separately deployed worker.
 *
 * The IMAP server, mail-sync, the MTA and the code-worker run in their own
 * images and call this backend (functions over the admin key, or signed HTTP
 * routes); the backend calls some of them back. Each pair is a contract
 * between two images that are not upgraded at the same moment, so for a while
 * an older worker talks to a newer backend. Each worker reports its wire
 * version at startup and every {@link WORKER_REPORT_INTERVAL_MS}
 * (`maintenance/workerRegistry`), and the backend compares the integer against
 * that service's own window below, never a release string: release strings say
 * nothing about the contract, and `dev` builds have none.
 *
 * Bump rules, per service:
 *
 * - Bump `current` in the PR that changes that worker's contract: a function or
 *   route it calls gains, loses or changes an argument or result field, or it
 *   starts calling something the previous backend lacks. The backend and the
 *   worker ship from the same commit, so both sides move together.
 * - Raise `minSupported` only in the PR that removes a compatibility path, and
 *   only to a version every release inside the supported skew window speaks.
 *   A migration that removes what older workers still read or write declares
 *   the versions it needs (`requiresWorkers` in `migrations/manifest.ts`) and
 *   the runner waits until every reporting worker has moved.
 *
 * Wire numbers are independent per service: MTA wire 2 and IMAP wire 2 are
 * unrelated contracts.
 *
 * Dependency-free on purpose: the api, imap, mail-sync, mta and web images all
 * read it. The code-worker image ships compiled JavaScript without this
 * package and keeps its own copy of its number (`apps/code-worker/src/wireVersion.ts`,
 * kept equal by `__tests__/workerWire.test.ts`).
 */

import { IMAP_WIRE_MIN_SUPPORTED, IMAP_WIRE_VERSION } from './imapWire';

export const WORKER_SERVICES = ['imap', 'mail-sync', 'mta', 'code-worker'] as const;

export type WorkerService = (typeof WORKER_SERVICES)[number];

/** What a worker from before reporting counts as, for every service. */
export const WORKER_WIRE_LEGACY = 0;

/** How often a running worker reports; the backend's liveness window is a multiple of it. */
export const WORKER_REPORT_INTERVAL_MS = 5 * 60_000;

export interface WorkerWireWindow {
	/** The contract this build speaks for the service. */
	current: number;
	/** The oldest contract of the service the backend still serves. */
	minSupported: number;
}

const WIRE_WINDOWS: Readonly<Record<Exclude<WorkerService, 'imap'>, WorkerWireWindow>> = {
	'mail-sync': { current: 1, minSupported: 0 },
	mta: { current: 1, minSupported: 0 },
	'code-worker': { current: 1, minSupported: 0 },
};

/**
 * Per service, the contract this build speaks and the oldest one it serves.
 *
 * - imap: `@owlat/shared/imapWire`, which keeps its own history.
 * - mail-sync, mta, code-worker: 1 is the first release that reports. Nothing
 *   has been contracted, so the releases before it (wire 0) are still served.
 */
export function workerWireWindow(service: WorkerService): WorkerWireWindow {
	if (service === 'imap') {
		return { current: IMAP_WIRE_VERSION, minSupported: IMAP_WIRE_MIN_SUPPORTED };
	}
	return WIRE_WINDOWS[service];
}

/**
 * How one worker's contract relates to the backend's:
 * - `current`: the same contract.
 * - `supported`: older, still served through a compatibility path.
 * - `unsupported`: older than the backend serves.
 * - `ahead`: newer than the backend; the backend has to be updated first.
 */
export type WorkerWireVerdict = 'current' | 'supported' | 'unsupported' | 'ahead';

export function workerWireVerdict(
	workerWireVersion: number,
	window: WorkerWireWindow
): WorkerWireVerdict {
	if (workerWireVersion > window.current) return 'ahead';
	if (workerWireVersion === window.current) return 'current';
	if (workerWireVersion >= window.minSupported) return 'supported';
	return 'unsupported';
}

/** The backend's answer to one report, the same shape for every service. */
export interface WorkerWireReportResult {
	backendWireVersion: number;
	minSupportedWireVersion: number;
	compatible: boolean;
	reason?: 'server_too_old' | 'backend_older';
}

export function workerWireReportResult(
	workerWireVersion: number,
	window: WorkerWireWindow
): WorkerWireReportResult {
	const verdict = workerWireVerdict(workerWireVersion, window);
	const result: WorkerWireReportResult = {
		backendWireVersion: window.current,
		minSupportedWireVersion: window.minSupported,
		compatible: verdict === 'current' || verdict === 'supported',
	};
	if (verdict === 'unsupported') result.reason = 'server_too_old';
	if (verdict === 'ahead') result.reason = 'backend_older';
	return result;
}
