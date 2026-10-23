/**
 * The snapshot an update takes before it changes anything a rollback could not
 * undo, and the durable record of where that snapshot stands.
 *
 * Taken after the pull and before `convex-deploy`: the deploy is the first step
 * that writes to the Convex database, and every step after it replaces the
 * compose file, `.env` and the containers. It holds the data of the two stores
 * a release migrates (the volumes, or binds, mounted read-write into `convex`
 * and `redis`), copied while both are stopped for a consistent copy, the way
 * scripts/backup.sh does it, plus the compose file, its override and `.env`.
 *
 * `snapshot.json` is the journal, written with an fsync before each state
 * change so a process killed at any point leaves a state the next one can act
 * on:
 *
 *   - `capturing`: the copy is in progress. Never restorable; the next start
 *     starts the containers the capture paused and discards it.
 *   - `armed`: the update is on trial. A failure before the new release is
 *     confirmed ready rolls back to it (rollback.ts).
 *   - `kept`: the release was confirmed ready. Nothing rolls back to it
 *     automatically any more; `owlat rollback` still can.
 *   - `restoring`: a rollback has begun overwriting the stack. The data may be
 *     half-written, so no update may start until a rollback finishes it.
 *   - `restored`: the stack runs on the snapshot again.
 *
 * One snapshot is kept: the next update replaces it. It lives in the install
 * directory, where the updater sees it and its helper containers reach it
 * through the same bind mount.
 */
import { createHash } from 'node:crypto';
import {
	closeSync,
	createReadStream,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { exec, OWLAT_DIR } from './http.js';
import { composeArgv, inspectSelf, oneLine } from './rollout.js';

export interface SnapshotStep {
	step: string;
	ok?: boolean;
	stdout: string;
	stderr: string;
}

type SnapshotState = 'capturing' | 'armed' | 'kept' | 'restoring' | 'restored';

/** One read-write mount of a stateful service, and the payload holding its copy. */
export interface SnapshotMount {
	service: string;
	kind: 'volume' | 'bind';
	/** The volume name, or the host path of a bind. */
	source: string;
	/** File name under `data/`. */
	payload: string;
	bytes?: number;
	sha256?: string;
}

export interface Snapshot {
	id: string;
	takenAt: number;
	state: SnapshotState;
	/** The `OWLAT_VERSION` `.env` pinned when the snapshot was taken. */
	fromVersion: string | null;
	targetVersion: string | null;
	/** Containers the capture stopped, so a capture cut short can start them again. */
	paused: string[];
	mounts: SnapshotMount[];
	/** Install-directory files copied under `config/`. */
	files: string[];
}

/** The services whose data a release migrates. */
const STATEFUL_SERVICES = new Set(['convex', 'redis']);

/** The files a rollback puts back; `.env` holds every deployment secret. */
export const SNAPSHOT_FILES = ['docker-compose.yml', 'docker-compose.override.yml', '.env'];

export const SNAPSHOT_DIR = join(OWLAT_DIR, '.owlat-update-snapshot');
const JOURNAL = join(SNAPSHOT_DIR, 'snapshot.json');

/** Labels the short-lived copy containers, so they are never mistaken for the stack's. */
const HELPER_LABEL = 'ink.wolves.owlat.role=update-snapshot-helper';

/** Volume names and host paths, before they reach a `-v` argument. */
const SAFE_SOURCE = /^[A-Za-z0-9_/][A-Za-z0-9_./@-]*$/;

/** What the copy may take: a large Convex database is gigabytes. */
export const COPY_TIMEOUT_MS = 30 * 60_000;

const SNAPSHOT_ID = /^snap-[a-z0-9]+-[0-9a-f]{8}$/;

export function isSnapshotId(value: unknown): value is string {
	return typeof value === 'string' && SNAPSHOT_ID.test(value);
}

const STATES = new Set<string>(['capturing', 'armed', 'kept', 'restoring', 'restored']);

/** The journal, or null when there is no snapshot worth reading. */
export function readSnapshot(): Snapshot | null {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(JOURNAL, 'utf-8'));
	} catch {
		return null;
	}
	const record = value as Partial<Snapshot> | null;
	if (
		!record ||
		!isSnapshotId(record.id) ||
		!STATES.has(record.state as string) ||
		!Array.isArray(record.mounts) ||
		!Array.isArray(record.files) ||
		!Array.isArray(record.paused)
	) {
		return null;
	}
	return record as Snapshot;
}

/**
 * Persist `snapshot` so it survives a crash: a temp file, fsynced, renamed
 * over the journal, then the directory fsynced. Unlike the rollout record this
 * is not best-effort, so it throws.
 */
export function writeSnapshot(snapshot: Snapshot): void {
	const tmp = `${JOURNAL}.tmp`;
	const fd = openSync(tmp, 'w', 0o600);
	try {
		writeSync(fd, JSON.stringify(snapshot));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, JOURNAL);
	try {
		const dir = openSync(dirname(JOURNAL), 'r');
		try {
			fsyncSync(dir);
		} finally {
			closeSync(dir);
		}
	} catch {
		// Not every filesystem lets a directory be fsynced; the rename is atomic either way.
	}
}

/** Move the snapshot on to `state`, keeping the rest of its record. */
export function markSnapshot(snapshot: Snapshot, state: SnapshotState): Snapshot {
	const next = { ...snapshot, state };
	writeSnapshot(next);
	return next;
}

export async function discardSnapshot(): Promise<void> {
	await rm(SNAPSHOT_DIR, { recursive: true, force: true });
}

export interface Plumbing {
	image: string;
	/** The snapshot directory as the HOST sees it, for a helper's `-v`. */
	hostSnapshotDir: string;
}

/** What a copy helper is started from: this container's own image and install bind. */
export async function helperPlumbing(): Promise<Plumbing | null> {
	const self = await inspectSelf();
	const bind = self?.binds.find((mount) => mount.split(':')[1] === OWLAT_DIR);
	const hostDir = bind?.split(':')[0];
	if (!self || !hostDir) return null;
	return { image: self.image, hostSnapshotDir: join(hostDir, '.owlat-update-snapshot') };
}

/**
 * `docker run` for a helper that only copies files: no network, no Docker
 * access, removed when it exits. It runs the updater's own image (already on
 * the host), whose busybox has `tar`, `du` and `find`.
 */
export function helperRun(image: string, mounts: string[], entrypoint: string, args: string[]) {
	return [
		'run',
		'--rm',
		'--label',
		HELPER_LABEL,
		'--network',
		'none',
		'--security-opt',
		'no-new-privileges',
		...mounts.flatMap((mount) => ['-v', mount]),
		'--entrypoint',
		entrypoint,
		image,
		...args,
	];
}

interface StatefulContainer {
	id: string;
	running: boolean;
	service: string;
	mounts: Array<{ kind: 'volume' | 'bind'; source: string }>;
}

/**
 * The containers of the stateful services and their read-write mounts, read
 * off the containers themselves, so a renamed volume or a bind an override
 * added is copied too.
 */
export async function statefulContainers(): Promise<StatefulContainer[] | { error: string }> {
	const listed = await exec(
		'docker',
		[...(await composeArgv()), 'ps', '--all', '--quiet'],
		OWLAT_DIR
	);
	if (!listed.ok) return { error: `cannot list the stack's containers: ${oneLine(listed.stderr)}` };
	const ids = listed.stdout
		.split('\n')
		.map((id) => id.trim())
		.filter(Boolean);
	if (ids.length === 0) return [];
	if (ids.some((id) => !/^[0-9a-f]{6,64}$/.test(id))) {
		return { error: 'the container list holds an id that is not one' };
	}

	const format =
		'{{.Id}}|{{.State.Running}}|{{index .Config.Labels "com.docker.compose.service"}}|' +
		'{{range .Mounts}}{{if .RW}}{{.Type}}={{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}} {{end}}{{end}}';
	const inspected = await exec('docker', ['inspect', '--format', format, ...ids], OWLAT_DIR);
	if (!inspected.ok)
		return { error: `cannot inspect the stack's containers: ${oneLine(inspected.stderr)}` };

	const containers: StatefulContainer[] = [];
	for (const line of inspected.stdout.split('\n')) {
		const [id = '', running = '', service = '', mounts = ''] = line.trim().split('|');
		if (!id || !STATEFUL_SERVICES.has(service)) continue;
		const parsed: StatefulContainer['mounts'] = [];
		for (const entry of mounts.split(' ').filter(Boolean)) {
			const [kind, source = ''] = entry.split('=');
			if (kind !== 'volume' && kind !== 'bind') continue;
			if (!SAFE_SOURCE.test(source)) {
				return { error: `${service} mounts ${kind} "${source}", which cannot be copied safely` };
			}
			parsed.push({ kind, source });
		}
		containers.push({ id, running: running === 'true', service, mounts: parsed });
	}
	return containers;
}

/** SHA-256 of a payload, streamed: a database copy does not fit in memory. */
export function sha256File(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		createReadStream(path)
			.on('data', (chunk) => hash.update(chunk))
			.on('error', reject)
			.on('end', () => resolve(hash.digest('hex')));
	});
}
