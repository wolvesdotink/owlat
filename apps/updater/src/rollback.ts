/**
 * Putting the stack back on the snapshot an update took before it changed
 * anything (snapshot.ts).
 *
 * Two callers share it. An update whose release fails before it is confirmed
 * ready rolls back on its own (update.ts). Once a release has been confirmed
 * ready nothing rolls back automatically, but the snapshot is kept and the
 * operator can still ask for it with `owlat rollback`, which reaches
 * `POST /rollback` here. Both run the same restore, so the manual path is the
 * one the automatic path has already exercised.
 *
 * A restore discards everything written since the snapshot: mail received,
 * contacts added, sends recorded. That is why it never runs once a release
 * has been confirmed ready without the operator naming the snapshot.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeOwnerOnlyFile } from '@owlat/shared/ownerOnlyFile';
import { errorMessage } from '@owlat/shared';
import { exec, json, OWLAT_DIR, readBody } from './http.js';
import {
	composeArgv,
	oneLine,
	scheduleUpdaterRecreateSafely,
	servicesToRecreate,
} from './rollout.js';
import { verifyReadiness } from './readiness.js';
import { isRateLimited } from './security.js';
import {
	COPY_TIMEOUT_MS,
	helperPlumbing,
	helperRun,
	isSnapshotId,
	markSnapshot,
	readSnapshot,
	sha256File,
	SNAPSHOT_DIR,
	statefulContainers,
	type Snapshot,
	type SnapshotStep,
} from './snapshot.js';

interface RollbackResult {
	/** The previous release is back and passed the readiness check. */
	ok: boolean;
	/** How far it got: nothing overwritten yet, data partly overwritten, or all of it back. */
	reached: 'untouched' | 'partial' | 'restored';
	steps: SnapshotStep[];
	/** One sentence on what happened, for the answer. */
	summary: string;
	warnings: string[];
}

/** Every payload is where the snapshot left it, at the size and hash it recorded. */
async function damagedPayload(snapshot: Snapshot): Promise<string | null> {
	for (const mount of snapshot.mounts) {
		const path = join(SNAPSHOT_DIR, 'data', mount.payload);
		try {
			if ((await sha256File(path)) !== mount.sha256) {
				return `the copy of ${mount.source} has changed`;
			}
		} catch {
			return `the copy of ${mount.source} is missing`;
		}
	}
	for (const file of snapshot.files) {
		try {
			await readFile(join(SNAPSHOT_DIR, 'config', file), 'utf-8');
		} catch {
			return `its copy of ${file} is missing`;
		}
	}
	return null;
}

/**
 * Every running container that writes to what is about to be overwritten:
 * the stateful services, and anything else that mounts one of the volumes.
 */
async function writersOf(snapshot: Snapshot): Promise<string[] | { error: string }> {
	const found = await statefulContainers();
	if ('error' in found) return found;
	const ids = new Set(found.filter((c) => c.running).map((c) => c.id));
	for (const mount of snapshot.mounts) {
		if (mount.kind !== 'volume') continue;
		const users = await exec(
			'docker',
			['ps', '--quiet', '--no-trunc', '--filter', `volume=${mount.source}`],
			OWLAT_DIR
		);
		if (!users.ok) {
			return { error: `cannot list what uses ${mount.source}: ${oneLine(users.stderr)}` };
		}
		for (const line of users.stdout.split('\n')) if (line.trim()) ids.add(line.trim());
	}
	return [...ids];
}

/**
 * Overwrite the stack with the snapshot and start the release it holds.
 *
 * The journal moves to `restoring` before the first container is stopped, so
 * an updater killed partway leaves a record that refuses further updates
 * until a rollback finishes, rather than an update over half-restored data.
 *
 * Never throws: both callers are answering a request about a failure, and a
 * throw would leave it unanswered. A journal that cannot be written is
 * reported as a rollback that may have stopped partway.
 */
export async function rollBack(
	snapshot: Snapshot,
	preExisting: Map<string, string> = new Map()
): Promise<RollbackResult> {
	const steps: SnapshotStep[] = [];
	try {
		return await restoreAndStart(snapshot, preExisting, steps);
	} catch (err) {
		const reason = `the rollback stopped: ${errorMessage(err)}`;
		steps.push({ step: 'rollback-restore', ok: false, stdout: '', stderr: reason });
		return { ok: false, reached: 'partial', steps, summary: `${reason}.`, warnings: [] };
	}
}

async function restoreAndStart(
	snapshot: Snapshot,
	preExisting: Map<string, string>,
	steps: SnapshotStep[]
): Promise<RollbackResult> {
	const result = (
		reached: RollbackResult['reached'],
		summary: string,
		ok = false,
		warnings: string[] = []
	): RollbackResult => ({ ok, reached, steps, summary, warnings });
	const fail = (step: string, reason: string) =>
		steps.push({ step, ok: false, stdout: '', stderr: reason });

	const damaged = await damagedPayload(snapshot);
	const plumbing = damaged ? null : await helperPlumbing();
	if (damaged || !plumbing) {
		const reason = damaged
			? `the snapshot cannot be used: ${damaged}`
			: 'cannot read the install directory this updater is mounted from';
		fail('rollback-restore', reason);
		return result('untouched', `${reason}. Nothing was restored.`);
	}

	const previousState = snapshot.state;
	let current = markSnapshot(snapshot, 'restoring');

	// Stop the writers. Until a byte is overwritten, a failure here puts them
	// back as they were.
	const writers = await writersOf(current);
	const stopped =
		'error' in writers
			? { ok: false, stdout: '', stderr: writers.error }
			: writers.length > 0
				? await exec('docker', ['stop', ...writers], OWLAT_DIR)
				: { ok: true, stdout: '', stderr: '' };
	if (!stopped.ok) {
		if (Array.isArray(writers) && writers.length > 0) {
			await exec('docker', ['start', ...writers], OWLAT_DIR);
		}
		markSnapshot(current, previousState);
		const reason = `could not stop what writes to the data: ${oneLine(stopped.stderr)}`;
		fail('rollback-restore', reason);
		return result('untouched', `${reason}. Nothing was restored.`);
	}

	for (const mount of current.mounts) {
		const restored = await exec(
			'docker',
			helperRun(
				plumbing.image,
				[`${mount.source}:/target`, `${plumbing.hostSnapshotDir}:/snapshot:ro`],
				'sh',
				[
					'-c',
					'find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -xf "$2" -C "$1"',
					'sh',
					'/target',
					`/snapshot/data/${mount.payload}`,
				]
			),
			OWLAT_DIR,
			{ timeoutMs: COPY_TIMEOUT_MS }
		);
		if (!restored.ok) {
			const reason = `restoring ${mount.source} failed: ${oneLine(restored.stderr)}`;
			fail('rollback-restore', reason);
			return result(
				'partial',
				`${reason}. What writes to that data is stopped, on partly restored data.`
			);
		}
	}

	try {
		for (const file of current.files) {
			const content = await readFile(join(SNAPSHOT_DIR, 'config', file), 'utf-8');
			const target = join(OWLAT_DIR, file);
			// `.env` holds every deployment secret; it stays owner-only.
			if (file === '.env') await writeOwnerOnlyFile(target, content);
			else await writeFile(target, content, 'utf-8');
		}
	} catch (err) {
		const reason = `restoring the configuration failed: ${errorMessage(err)}`;
		fail('rollback-restore', reason);
		return result('partial', `${reason}. The data is restored; convex and redis are stopped.`);
	}
	current = markSnapshot(current, 'restored');
	steps.push({
		step: 'rollback-restore',
		ok: true,
		stdout: `Restored ${[...current.mounts.map((m) => m.source), ...current.files].join(', ')} from snapshot ${current.id}`,
		stderr: '',
	});

	const plan = await servicesToRecreate();
	const compose = await composeArgv();
	const up = plan.error
		? { ok: false, stdout: '', stderr: plan.error }
		: await exec(
				'docker',
				[...compose, 'up', '-d', '--remove-orphans', ...plan.services],
				OWLAT_DIR
			);
	steps.push({ step: 'rollback-up', ...up });
	if (!up.ok) {
		return result('restored', `starting the previous release failed: ${oneLine(up.stderr)}.`);
	}

	const readiness = await verifyReadiness(plan.services, compose, { preExisting });
	steps.push({
		step: 'rollback-readiness',
		ok: readiness.ready,
		stdout: readiness.ready ? readiness.summary : '',
		stderr: readiness.ready ? '' : readiness.summary,
	});
	if (!readiness.ready) {
		return result(
			'restored',
			`the previous release did not pass the readiness check. ${readiness.summary}`,
			false,
			readiness.warnings
		);
	}
	return result('restored', readiness.summary, true, readiness.warnings);
}

const when = (snapshot: Snapshot) => new Date(snapshot.takenAt).toISOString();

/** What a snapshot holds, in the words the operator confirms a restore with. */
function describeSnapshot(snapshot: Snapshot): string {
	const update = snapshot.targetVersion
		? `the update from ${snapshot.fromVersion ?? 'an unknown release'} to ${snapshot.targetVersion}`
		: 'an update';
	return (
		`Snapshot ${snapshot.id}, taken ${when(snapshot)} before ${update} (${snapshot.state}). ` +
		`Restoring it puts back the data of ${[...new Set(snapshot.mounts.map((m) => m.service))].join(' and ') || 'no service'}` +
		` and ${snapshot.files.join(', ') || 'no configuration file'} as they were then. ` +
		'Everything written to the instance since is lost.'
	);
}

/** The answer an update gives after it rolled back (or tried to). */
export function rollbackAnswer(
	snapshot: Snapshot,
	failure: string,
	rollback: RollbackResult
): string {
	if (rollback.ok) {
		return (
			`${failure} The update was rolled back to the snapshot taken ${when(snapshot)} (${snapshot.id}): ` +
			`the previous release is serving again on the data, compose file and .env it had then. ` +
			'Anything written to the instance after the snapshot was discarded.'
		);
	}
	if (rollback.reached === 'untouched') {
		return (
			`${failure} Rolling back failed: ${rollback.summary} The stack is configured as it was before ` +
			'the rollback. On the host, `owlat rollback` retries it; `docker compose up -d` starts what is configured.'
		);
	}
	if (rollback.reached === 'partial') {
		return (
			`${failure} Rolling back failed partway: ${rollback.summary} ` +
			'On the host, run `owlat rollback` to finish it. No update can start until it has.'
		);
	}
	return (
		`${failure} The data and configuration were restored from the snapshot taken ${when(snapshot)} ` +
		`(${snapshot.id}), but ${rollback.summary} Check \`docker compose ps\` on the host.`
	);
}

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
	let requested: unknown;
	try {
		requested = JSON.parse((await readBody(req)) || '{}').snapshot;
	} catch {
		return json(res, 400, { error: 'Invalid JSON body' });
	}

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

	console.error(`[rollback] restoring snapshot ${snapshot.id} on the operator's request`);
	const rollback = await rollBack(snapshot);
	const steps = [...rollback.steps];
	// The updater itself follows the release it restored, like after an update.
	if (rollback.ok) steps.push(await scheduleUpdaterRecreateSafely());
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
