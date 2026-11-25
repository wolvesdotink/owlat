/**
 * The two routes `owlat rollback` drives: `GET /snapshot` shows what a restore
 * would bring back, `POST /rollback` restores it (rollback.ts does the work).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parserDecoder } from '@owlat/worker-protocol/decodeJson';
import { json } from './http.js';
import { readJsonBody } from './jsonBody.js';
import { asRecord } from './requestBodies.js';
import { scheduleUpdaterRecreateSafely } from './rollout.js';
import { isRateLimited } from './security.js';
import { isSnapshotId, readSnapshot } from './snapshot.js';
import { describeSnapshot, rollBack, rollbackAnswer, when } from './rollback.js';
import { recordRunningVersion } from './versionRecord.js';

/** `GET /snapshot`: the snapshot `owlat rollback` would restore, if any. */
export function handleSnapshotInfo(res: ServerResponse) {
	if (isRateLimited('snapshot', 20, 60_000)) {
		return json(res, 429, { error: 'Too many snapshot requests.' });
	}
	const snapshot = readSnapshot();
	if (!snapshot || snapshot.state === 'capturing') {
		return json(res, 200, { snapshot: null, description: 'There is no snapshot to roll back to.' });
	}
	const { id, takenAt, state, fromVersion, targetVersion } = snapshot;
	return json(res, 200, {
		snapshot: { id, takenAt, state, fromVersion, targetVersion },
		description: describeSnapshot(snapshot),
	});
}

/**
 * `POST /rollback {"snapshot": "<id>"}`: restore the kept snapshot on the
 * operator's word. The id has to match the snapshot on disk, so a restore is
 * only ever of the snapshot the operator was shown.
 */
export async function handleRollback(req: IncomingMessage, res: ServerResponse) {
	if (isRateLimited('rollback', 2, 60_000)) {
		return json(res, 429, { error: 'Too many rollback requests. Try again later.' });
	}
	const body = await readJsonBody(req, res, parserDecoder(asRecord, '$: expected object'), {
		emptyBody: {},
	});
	if (!body) return;
	const requested = body['snapshot'];

	const snapshot = readSnapshot();
	if (!snapshot || snapshot.state === 'capturing') {
		return json(res, 404, { error: 'There is no snapshot to roll back to.' });
	}
	if (!isSnapshotId(requested) || requested !== snapshot.id) {
		return json(res, 400, {
			error: `Name the snapshot to restore: ${describeSnapshot(snapshot)}`,
			snapshot: { id: snapshot.id },
		});
	}
	if (snapshot.state === 'restored') {
		return json(res, 409, {
			error: `The stack already runs on snapshot ${snapshot.id}; restoring it again would discard what was written since.`,
		});
	}

	console.error(
		snapshot.state === 'starting'
			? `[rollback] starting the release restored from snapshot ${snapshot.id} on the operator's request`
			: `[rollback] restoring snapshot ${snapshot.id} on the operator's request`
	);
	const rollback = await rollBack(snapshot);
	const steps = [...rollback.steps];
	if (rollback.ok) {
		// The restored `.env` pins the snapshot's release; VERSION goes back with it.
		if (snapshot.fromVersion) {
			steps.push(await recordRunningVersion(snapshot.fromVersion, 'rollback'));
		}
		// The updater itself follows the release it restored, like after an update.
		steps.push(await scheduleUpdaterRecreateSafely());
	}
	const description = rollback.ok
		? `Rolled back to snapshot ${snapshot.id}: the stack runs the release and data from ${when(snapshot)} again. ${rollback.summary}`
		: rollbackAnswer(snapshot, 'The rollback did not complete.', rollback);
	if (!rollback.ok) console.error('[rollback]', description);
	json(res, rollback.ok ? 200 : 500, {
		success: rollback.ok,
		rollout: rollback.ok ? 'rolled-back' : 'failed',
		description,
		...(rollback.ok ? {} : { error: description }),
		warnings: rollback.warnings,
		steps,
	});
}
