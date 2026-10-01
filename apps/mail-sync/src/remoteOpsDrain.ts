/**
 * Drains an account's write-back queue: lists the due ops a page at a time,
 * replays each one (remoteOps.ts) and settles the page with the backend.
 */

import { describeRemoteOpError } from './imapCommandErrors.js';
import type { RemoteOpReplayer } from './remoteOps.js';
import type { RemoteOp, RemoteOpResult, RemoteOpsClient } from './remoteOpTypes.js';

export interface DrainDeps {
	listDue(): Promise<RemoteOp[]>;
	settle(results: RemoteOpResult[]): Promise<void>;
	replayer: RemoteOpReplayer;
	client: Pick<RemoteOpsClient, 'usable'>;
	isStopped(): boolean;
	onError(op: RemoteOp, err: unknown): void;
}

/**
 * Apply every due op, a page at a time, until none is left. A failed op is
 * settled as `failed` (the backend backs it off, so it is not listed again in
 * this drain); a lost connection ends the drain after settling what was done.
 */
export async function drainRemoteOps(deps: DrainDeps): Promise<void> {
	for (;;) {
		if (deps.isStopped()) return;
		const ops = await deps.listDue();
		if (ops.length === 0) return;
		const results: RemoteOpResult[] = [];
		let connectionLost = false;
		for (const op of ops) {
			if (deps.isStopped() || connectionLost) break;
			try {
				results.push({ opId: op.opId, outcome: await deps.replayer.apply(op) });
			} catch (err) {
				deps.onError(op, err);
				if (!deps.client.usable) {
					// Not the op's fault — leave it untouched for the reconnect.
					connectionLost = true;
					break;
				}
				results.push({ opId: op.opId, outcome: 'failed', error: describeRemoteOpError(err) });
			}
		}
		if (results.length > 0) await deps.settle(results);
		if (connectionLost || results.length < ops.length) return;
	}
}

/** Pauses before the second and third attempt to record a folder rename. */
const RENAME_REPORT_RETRY_MS = [500, 2_000];

export interface RenameReportDeps {
	/** Record the rename with the backend. */
	record(): Promise<unknown>;
	/** The backend predates the report: it has no mutation to record it in. */
	isUnsupported(err: unknown): boolean;
	sleep?(ms: number): Promise<void>;
}

/**
 * Record a folder rename the provider already carried out. Until the backend
 * has it, the backend names the folder, and every op queued for it, by the old
 * name, so a transient failure is retried here and then thrown: the rename op
 * fails, stays queued, and its retry reports again. False for a backend that
 * predates the report, which settles the op as before: the ops still naming
 * the old folder reach it through this worker's own rename map.
 */
export async function reportFolderRename(deps: RenameReportDeps): Promise<boolean> {
	const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	for (let attempt = 0; ; attempt++) {
		try {
			await deps.record();
			return true;
		} catch (err) {
			if (deps.isUnsupported(err)) return false;
			const delay = RENAME_REPORT_RETRY_MS[attempt];
			if (delay === undefined) throw err;
			await sleep(delay);
		}
	}
}
