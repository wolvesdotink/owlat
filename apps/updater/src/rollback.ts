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
import { readFile, rm, writeFile } from 'node:fs/promises';
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
import { removeUpdateContainers, resolveInstallation } from './deployRun.js';
import { isRateLimited } from './security.js';
import {
	COPY_TIMEOUT_MS,
	helperPlumbing,
	helperRun,
	inspectContainers,
	isSnapshotId,
	markSnapshot,
	mountsSource,
	readSnapshot,
	sha256File,
	SNAPSHOT_DIR,
	statefulContainers,
	UNFINISHED_STATES,
	type Snapshot,
	type SnapshotStep,
} from './snapshot.js';

interface RollbackResult {
	/** The previous release is back and passed the readiness check. */
	ok: boolean;
	/**
	 * How far it got: nothing overwritten yet, data partly overwritten, or all
	 * of it back (the journal then says `starting` until the release it
	 * belongs to passes the readiness check, and `restored` once it has).
	 */
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
 * the stateful services, and anything else that mounts one of the volumes or
 * binds, a copy helper of an earlier restore included. Docker's `volume`
 * filter also matches a container that only mounts something else AT that
 * path, so each one it lists is inspected and kept only when it mounts the
 * source itself.
 */
async function writersOf(snapshot: Snapshot): Promise<string[] | { error: string }> {
	const found = await statefulContainers();
	if ('error' in found) return found;
	const ids = new Set(found.filter((c) => c.running).map((c) => c.id));
	const listed = new Set<string>();
	for (const mount of snapshot.mounts) {
		const users = await exec(
			'docker',
			['ps', '--quiet', '--no-trunc', '--filter', `volume=${mount.source}`],
			OWLAT_DIR
		);
		if (!users.ok) {
			return { error: `cannot list what uses ${mount.source}: ${oneLine(users.stderr)}` };
		}
		for (const line of users.stdout.split('\n')) if (line.trim()) listed.add(line.trim());
	}
	const users = await inspectContainers([...listed].filter((id) => !ids.has(id)));
	if ('error' in users) return { error: `cannot inspect what uses the data: ${users.error}` };
	for (const user of users) {
		const writes = user.mounts.some((m) => snapshot.mounts.some((s) => mountsSource(m, s)));
		if (user.running && writes) ids.add(user.id);
	}
	return [...ids];
}

/**
 * Overwrite the stack with the snapshot and start the release it holds.
 *
 * The journal moves to `restoring` before the first container is stopped, so
 * an updater killed partway leaves a record that refuses further updates
 * until a rollback finishes, rather than an update over half-restored data.
 * Once the data and configuration are back it says `starting`, and a rollback
 * resumed from there only starts the release and checks it again: the data
 * is not copied back over what that release may have written since.
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

	if (snapshot.state === 'starting') {
		steps.push({
			step: 'rollback-restore',
			ok: true,
			stdout: `The data and configuration of snapshot ${snapshot.id} were already restored; starting the release they belong to again.`,
			stderr: '',
		});
		return startRestored(snapshot, preExisting, steps);
	}

	// Which containers are this installation's is read once: the copy helpers
	// below are labelled with it, and the leftovers are looked for by it.
	const installation = await resolveInstallation();
	if (!installation.ok) {
		const reason = `cannot tell which containers belong to this install: ${installation.reason}`;
		fail('rollback-restore', reason);
		return result('untouched', `${reason}. Nothing was restored.`);
	}
	const damaged = await damagedPayload(snapshot);
	const plumbing = damaged ? null : await helperPlumbing(installation.id);
	if (damaged || !plumbing) {
		const reason = damaged
			? `the snapshot cannot be used: ${damaged}`
			: 'cannot read the install directory this updater is mounted from';
		fail('rollback-restore', reason);
		return result('untouched', `${reason}. Nothing was restored.`);
	}

	// A deploy of this installation may still be running: the one of the
	// update that took the snapshot, or of a later update that took none (cut
	// off by its bound, or orphaned by a client that lost the daemon), and so
	// may a copy helper of a restore an earlier rollback lost. Each is stopped
	// and waited for first, or it could go on writing to the backend or the
	// data restored under it.
	const settled = await removeUpdateContainers(installation.id);
	if (!settled.ok) {
		const reason = `could not stop a container an update or rollback of this install started (${settled.reason})`;
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
				plumbing,
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
		// A file the snapshot did not have (an override a feature change added
		// since) would otherwise keep configuring the restored release.
		for (const file of current.absent) await rm(join(OWLAT_DIR, file), { force: true });
	} catch (err) {
		const reason = `restoring the configuration failed: ${errorMessage(err)}`;
		fail('rollback-restore', reason);
		return result('partial', `${reason}. The data is restored; convex and redis are stopped.`);
	}
	current = markSnapshot(current, 'starting');
	const removed = current.absent.map((file) => `removed ${file}, which it did not have`);
	steps.push({
		step: 'rollback-restore',
		ok: true,
		stdout:
			`Restored ${[...current.mounts.map((m) => m.source), ...current.files].join(', ')} from snapshot ${current.id}` +
			(removed.length > 0 ? `; ${removed.join(', ')}` : ''),
		stderr: '',
	});
	return startRestored(current, preExisting, steps);
}

/**
 * Start the release the restored data and configuration belong to, and only
 * once it passes the readiness check call the rollback finished.
 */
async function startRestored(
	snapshot: Snapshot,
	preExisting: Map<string, string>,
	steps: SnapshotStep[]
): Promise<RollbackResult> {
	const result = (summary: string, ok = false, warnings: string[] = []): RollbackResult => ({
		ok,
		reached: 'restored',
		steps,
		summary,
		warnings,
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
		return result(`starting the previous release failed: ${oneLine(up.stderr)}.`);
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
			`the previous release did not pass the readiness check. ${readiness.summary}`,
			false,
			readiness.warnings
		);
	}
	const warnings = [...readiness.warnings];
	try {
		markSnapshot(snapshot, 'restored');
	} catch (err) {
		// The rollback did finish; the journal still saying `starting` only costs
		// a later `owlat rollback` that starts the release and checks it again.
		warnings.push(
			`The rollback finished, but recording it failed (${errorMessage(err)}): run \`owlat rollback\` once more before the next update.`
		);
	}
	return result(readiness.summary, true, warnings);
}

const when = (snapshot: Snapshot) => new Date(snapshot.takenAt).toISOString();

/** What a snapshot holds, in the words the operator confirms a restore with. */
function describeSnapshot(snapshot: Snapshot): string {
	const update = snapshot.targetVersion
		? `the update from ${snapshot.fromVersion ?? 'an unknown release'} to ${snapshot.targetVersion}`
		: 'an update';
	const taken = `Snapshot ${snapshot.id}, taken ${when(snapshot)} before ${update} (${snapshot.state}).`;
	if (snapshot.state === 'starting') {
		return (
			`${taken} A rollback to it restored the data and configuration but did not confirm the ` +
			'release they belong to is serving. Rolling back again starts that release and checks it; ' +
			'the data is not copied back a second time.'
		);
	}
	const unfinished =
		snapshot.state === 'restoring'
			? ' A rollback to it stopped partway, so the data may be half-restored; rolling back again finishes it.'
			: '';
	return (
		`${taken}${unfinished} ` +
		`Restoring it puts back the data of ${[...new Set(snapshot.mounts.map((m) => m.service))].join(' and ') || 'no service'}` +
		` and ${snapshot.files.join(', ') || 'no configuration file'} as they were then` +
		(snapshot.absent.length > 0
			? `, and removes ${snapshot.absent.join(', ')}, which it did not have`
			: '') +
		'. Everything written to the instance since is lost.'
	);
}

/**
 * Why nothing but a rollback may change the stack, or null when something
 * may. A rollback that stopped partway left data that is half-restored, or
 * restored for a release that is not confirmed running; an update, a feature
 * change or a secret rotation run over it would start the stack on that.
 */
export function unfinishedRollback(): string | null {
	const snapshot = readSnapshot();
	if (!snapshot || !UNFINISHED_STATES.has(snapshot.state)) return null;
	return (
		`A rollback to snapshot ${snapshot.id}, taken before an earlier update, did not finish, so the ` +
		'stack may be running on half-restored data. Nothing was changed. Run `owlat rollback` on the ' +
		'host to finish it, then try again.'
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
		`(${snapshot.id}), but ${rollback.summary} Check \`docker compose ps\` on the host; ` +
		'`owlat rollback` starts that release again without copying the data back. No update can start until it has.'
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

	console.error(
		snapshot.state === 'starting'
			? `[rollback] starting the release restored from snapshot ${snapshot.id} on the operator's request`
			: `[rollback] restoring snapshot ${snapshot.id} on the operator's request`
	);
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
