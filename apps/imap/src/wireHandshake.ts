/**
 * The wire-version handshake with the backend (ADR-0063).
 *
 * Before it listens, the IMAP server reports its release and wire version to
 * `mail/imap/serverRegistry:report` and serves only once the backend answers
 * that it speaks this server's contract:
 *
 * - compatible: serve.
 * - this server is older than the backend supports: log what to update and
 *   refuse to start. Serving would call functions whose old shape is gone.
 * - the backend is older than this server (it has no `report` function yet, or
 *   reports a lower wire version): it may be mid-deploy, so wait and retry.
 *   The upgrade order is backend first; the IMAP server never runs ahead.
 * - the backend cannot be reached: retry.
 *
 * After that it reports every {@link WIRE_REPORT_INTERVAL_MS}. A later answer
 * that this server is no longer served (the backend was updated past it, or
 * rolled back below it) stops it through the normal shutdown path; a failed
 * report is only logged.
 */

import { getFunctionName } from 'convex/server';
import { IMAP_WIRE_VERSION, imapWireVerdict } from '@owlat/shared/imapWire';
import { fn, type ImapServerReportResult } from './convex.js';

/** How often a running server reports. */
export const WIRE_REPORT_INTERVAL_MS = 5 * 60_000;

/** Startup retry backoff: doubles from the first delay up to the cap. */
export const WIRE_RETRY_FIRST_MS = 1_000;
export const WIRE_RETRY_MAX_MS = 60_000;

/** What one report means for this server. */
export type WireReportOutcome =
	| { kind: 'compatible'; backendWireVersion: number }
	| { kind: 'tooOld'; backendWireVersion: number; minSupportedWireVersion: number; reason?: string }
	| { kind: 'backendOlder'; backendWireVersion: number | null }
	| { kind: 'unreachable'; err: unknown };

interface HandshakeLog {
	debug(obj: object, msg: string): void;
	warn(obj: object, msg: string): void;
	error(obj: object, msg: string): void;
}

export interface WireHandshakeDeps {
	/** One report with this process's identity; throws what the Convex client throws. */
	report: () => Promise<ImapServerReportResult>;
	owlatVersion: string;
	log: HandshakeLog;
	/** Defaults to `IMAP_WIRE_VERSION`; a seam for tests. */
	wireVersion?: number;
	/** Seams for tests. */
	sleep?: (ms: number) => Promise<void>;
	setInterval?: (callback: () => void, ms: number) => { unref?: () => unknown };
	clearInterval?: (handle: { unref?: () => unknown }) => void;
}

/**
 * Whether `err` is the backend answering that it has no `report` function: a
 * backend from before the handshake. Same test as mail-sync's
 * `isMissingFunction`; anything else, a network error or a 503 included, is not.
 */
function isMissingReportFunction(err: unknown): boolean {
	const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
	const named = /Could not find (?:public )?function for '([^']+)'/.exec(message)?.[1];
	return named?.replace(/\.js(?=:|$)/, '') === getFunctionName(fn.reportServer);
}

/** Classify one report (its result, or what it threw). */
export function classifyWireReport(
	answer: { result: ImapServerReportResult } | { err: unknown },
	wireVersion: number = IMAP_WIRE_VERSION
): WireReportOutcome {
	if ('err' in answer) {
		return isMissingReportFunction(answer.err)
			? { kind: 'backendOlder', backendWireVersion: null }
			: { kind: 'unreachable', err: answer.err };
	}
	const { backendWireVersion, minSupportedWireVersion, compatible, reason } = answer.result;
	const verdict = imapWireVerdict(wireVersion, backendWireVersion, minSupportedWireVersion);
	if (verdict === 'ahead') return { kind: 'backendOlder', backendWireVersion };
	if (verdict === 'unsupported' || !compatible) {
		// A refusal the numbers do not explain is a later backend's reason; it is
		// still a refusal.
		return {
			kind: 'tooOld',
			backendWireVersion,
			minSupportedWireVersion,
			...(reason ? { reason } : {}),
		};
	}
	return { kind: 'compatible', backendWireVersion };
}

async function reportOnce(deps: WireHandshakeDeps): Promise<WireReportOutcome> {
	const wireVersion = deps.wireVersion ?? IMAP_WIRE_VERSION;
	try {
		return classifyWireReport({ result: await deps.report() }, wireVersion);
	} catch (err) {
		return classifyWireReport({ err }, wireVersion);
	}
}

function logRefusal(
	deps: WireHandshakeDeps,
	outcome: Extract<WireReportOutcome, { kind: 'tooOld' }>,
	action: string
): void {
	const wireVersion = deps.wireVersion ?? IMAP_WIRE_VERSION;
	deps.log.error(
		{
			owlatVersion: deps.owlatVersion,
			wireVersion,
			backendWireVersion: outcome.backendWireVersion,
			minSupportedWireVersion: outcome.minSupportedWireVersion,
			...(outcome.reason ? { reason: outcome.reason } : {}),
		},
		`This IMAP server (release ${deps.owlatVersion}, wire version ${wireVersion}) is older ` +
			`than the backend supports (wire version ${outcome.minSupportedWireVersion} or newer). ` +
			`Update the IMAP container to the backend's release ` +
			`(docker compose pull imap && docker compose up -d imap). ${action}`
	);
}

function logBackendOlder(
	deps: WireHandshakeDeps,
	outcome: Extract<WireReportOutcome, { kind: 'backendOlder' }>,
	action: string
): void {
	const wireVersion = deps.wireVersion ?? IMAP_WIRE_VERSION;
	const backend =
		outcome.backendWireVersion === null
			? 'has no IMAP version handshake yet'
			: `speaks wire version ${outcome.backendWireVersion}`;
	deps.log.error(
		{
			owlatVersion: deps.owlatVersion,
			wireVersion,
			backendWireVersion: outcome.backendWireVersion,
		},
		`The backend ${backend}, older than this IMAP server (release ${deps.owlatVersion}, ` +
			`wire version ${wireVersion}). Update the backend first ` +
			`(docker compose --profile deploy run --rm convex-deploy); it may also be mid-deploy. ${action}`
	);
}

/**
 * Report until the backend answers. Resolves `serve` once it speaks this
 * server's contract, `refuse` when it no longer serves this server; waits (with
 * capped backoff) while the backend is older or unreachable.
 */
export async function awaitWireCompatibility(deps: WireHandshakeDeps): Promise<'serve' | 'refuse'> {
	const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	let delay = WIRE_RETRY_FIRST_MS;
	for (;;) {
		const outcome = await reportOnce(deps);
		if (outcome.kind === 'compatible') return 'serve';
		if (outcome.kind === 'tooOld') {
			logRefusal(deps, outcome, 'Refusing to start.');
			return 'refuse';
		}
		const retry = `Not serving IMAP yet; retrying in ${Math.round(delay / 1000)} s.`;
		if (outcome.kind === 'backendOlder') logBackendOlder(deps, outcome, retry);
		else {
			deps.log.warn(
				{ err: outcome.err },
				`Could not report this IMAP server's version to the backend. ${retry}`
			);
		}
		await sleep(delay);
		delay = Math.min(delay * 2, WIRE_RETRY_MAX_MS);
	}
}

/**
 * Report every {@link WIRE_REPORT_INTERVAL_MS} while serving. Calls
 * `onIncompatible` once, and stops, when the backend stops serving this
 * server's contract. The timer is unref'd: it never holds the process open.
 */
export function startWireReports(
	deps: WireHandshakeDeps,
	onIncompatible: (outcome: WireReportOutcome) => void
): { stop: () => void } {
	const set = deps.setInterval ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
	const clear =
		deps.clearInterval ??
		((handle: { unref?: () => unknown }) => clearInterval(handle as NodeJS.Timeout));
	let stopped = false;
	let inFlight = false;
	let handle: { unref?: () => unknown } | undefined;

	const stop = () => {
		if (stopped) return;
		stopped = true;
		if (handle) clear(handle);
	};

	const tick = async () => {
		if (stopped || inFlight) return;
		inFlight = true;
		try {
			const outcome = await reportOnce(deps);
			if (stopped) return;
			if (outcome.kind === 'compatible') {
				deps.log.debug(
					{ backendWireVersion: outcome.backendWireVersion },
					'IMAP wire version report accepted'
				);
				return;
			}
			if (outcome.kind === 'unreachable') {
				deps.log.warn(
					{ err: outcome.err },
					"Could not report this IMAP server's version to the backend; still serving, next report in 5 min."
				);
				return;
			}
			const action = 'Shutting down.';
			if (outcome.kind === 'tooOld') logRefusal(deps, outcome, action);
			else logBackendOlder(deps, outcome, action);
			stop();
			onIncompatible(outcome);
		} finally {
			inFlight = false;
		}
	};

	handle = set(() => void tick(), WIRE_REPORT_INTERVAL_MS);
	handle.unref?.();
	return { stop };
}
