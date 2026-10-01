/**
 * Drains an account's write-back queue: lists the due ops a page at a time,
 * replays each one (remoteOps.ts) and settles the page with the backend.
 */

import { describeRemoteOpError } from './imapCommandErrors.js';
import type { RemoteOp, RemoteOpReplayer, RemoteOpResult, RemoteOpsClient } from './remoteOps.js';

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
