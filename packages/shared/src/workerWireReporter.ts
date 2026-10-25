/**
 * The periodic wire-version report of a worker that does not gate its startup
 * on it (mail-sync, the MTA). The IMAP server has its own blocking handshake
 * (`apps/imap/src/wireHandshake.ts`) because it refuses to serve a backend that
 * no longer speaks its contract.
 *
 * Reports once at start and every {@link WORKER_REPORT_INTERVAL_MS} after. The
 * answer is logged, never acted on: these workers still serve every backend
 * inside the skew window, and the report exists so the backend can show the
 * skew and hold contract steps until every worker has moved. A failed report
 * is logged and retried at the next tick.
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
	WORKER_REPORT_INTERVAL_MS,
	workerWireVerdict,
	type WorkerService,
	type WorkerWireReportResult,
} from './workerWire';

interface ReporterLog {
	debug(obj: object, msg: string): void;
	warn(obj: object, msg: string): void;
	error(obj: object, msg: string): void;
}

type TimerHandle = { unref?: () => unknown };

/** The backend's answer as the reporter reads it. */
type WorkerWireReportAnswer = Omit<WorkerWireReportResult, 'reason'> & { reason?: string };

export interface WorkerWireReporterDeps {
	service: WorkerService;
	wireVersion: number;
	owlatVersion: string;
	/**
	 * One report; throws what the transport throws. `reason` is a hint the
	 * reporter never reads, so a later backend's unnamed reason still fits.
	 */
	report: () => Promise<WorkerWireReportAnswer>;
	log: ReporterLog;
	/** Seams for tests. */
	setInterval?: (callback: () => void, ms: number) => TimerHandle;
	clearInterval?: (handle: TimerHandle) => void;
}

/** What a worker says about its process in every report. */
export type WorkerReportIdentity = {
	/** Random per process. */
	instanceId: string;
	/** The container hostname (Docker: the container id), never an address. */
	hostLabel: string;
	/** The image's `OWLAT_VERSION`; `dev` when unset or empty. */
	owlatVersion: string;
	startedAt: number;
};

export function workerReportIdentity(
	env: NodeJS.ProcessEnv = process.env,
	now: number = Date.now()
): WorkerReportIdentity {
	return {
		instanceId: randomUUID(),
		hostLabel: hostname(),
		owlatVersion: env['OWLAT_VERSION'] || 'dev',
		startedAt: now,
	};
}

type WorkerWireReportOutcome =
	| { kind: 'compatible'; backendWireVersion: number }
	| { kind: 'tooOld'; backendWireVersion: number; minSupportedWireVersion: number }
	| { kind: 'backendOlder'; backendWireVersion: number }
	| { kind: 'unreachable'; err: unknown };

/** Classify the backend's answer from this worker's side of the contract. */
function classifyWorkerWireReport(
	result: WorkerWireReportAnswer,
	wireVersion: number
): WorkerWireReportOutcome {
	const verdict = workerWireVerdict(wireVersion, {
		current: result.backendWireVersion,
		minSupported: result.minSupportedWireVersion,
	});
	if (verdict === 'ahead') {
		return { kind: 'backendOlder', backendWireVersion: result.backendWireVersion };
	}
	// A refusal the numbers do not explain is a later backend's reason; it is
	// still a refusal.
	if (verdict === 'unsupported' || !result.compatible) {
		return {
			kind: 'tooOld',
			backendWireVersion: result.backendWireVersion,
			minSupportedWireVersion: result.minSupportedWireVersion,
		};
	}
	return { kind: 'compatible', backendWireVersion: result.backendWireVersion };
}

async function reportOnce(deps: WorkerWireReporterDeps): Promise<WorkerWireReportOutcome> {
	try {
		return classifyWorkerWireReport(await deps.report(), deps.wireVersion);
	} catch (err) {
		return { kind: 'unreachable', err };
	}
}

function logOutcome(deps: WorkerWireReporterDeps, outcome: WorkerWireReportOutcome): void {
	const identity = {
		service: deps.service,
		owlatVersion: deps.owlatVersion,
		wireVersion: deps.wireVersion,
	};
	const label = `This ${deps.service} worker (release ${deps.owlatVersion}, wire version ${deps.wireVersion})`;
	switch (outcome.kind) {
		case 'compatible':
			deps.log.debug(
				{ ...identity, backendWireVersion: outcome.backendWireVersion },
				'Wire version report accepted'
			);
			return;
		case 'tooOld':
			deps.log.error(
				{
					...identity,
					backendWireVersion: outcome.backendWireVersion,
					minSupportedWireVersion: outcome.minSupportedWireVersion,
				},
				`${label} is older than the backend supports (wire version ` +
					`${outcome.minSupportedWireVersion} or newer). Update this container to the backend's release.`
			);
			return;
		case 'backendOlder':
			deps.log.error(
				{ ...identity, backendWireVersion: outcome.backendWireVersion },
				`${label} is newer than the backend (wire version ${outcome.backendWireVersion}). ` +
					'Update the backend first; it may also be mid-deploy.'
			);
			return;
		case 'unreachable':
			deps.log.warn(
				{ ...identity, err: outcome.err },
				'Could not report the wire version to the backend; retrying at the next report.'
			);
			return;
	}
}

/**
 * Report now and every {@link WORKER_REPORT_INTERVAL_MS}. The timer is
 * unref'd, so it never holds the process open; `stop` ends it and drops a
 * report still in flight.
 */
export function startWorkerWireReports(deps: WorkerWireReporterDeps): { stop: () => void } {
	const set = deps.setInterval ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
	const clear =
		deps.clearInterval ?? ((handle: TimerHandle) => clearInterval(handle as NodeJS.Timeout));
	let stopped = false;
	let inFlight = false;

	const tick = async () => {
		if (stopped || inFlight) return;
		inFlight = true;
		try {
			const outcome = await reportOnce(deps);
			if (!stopped) logOutcome(deps, outcome);
		} finally {
			inFlight = false;
		}
	};

	const handle = set(() => void tick(), WORKER_REPORT_INTERVAL_MS);
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
