/**
 * Taking the update snapshot (snapshot.ts holds what it is and where it
 * stands).
 *
 * Convex keeps its state in SQLite and Redis in a multi-part AOF; a copy taken
 * while either writes can be torn in a way that only shows when it is
 * restored. So, like scripts/backup.sh, the running stateful containers are
 * stopped for the copy and started again straight after it, which costs the
 * instance its backend for as long as the copy takes. The checksums, which
 * take as long again, are computed once they are back.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from '@owlat/shared';
import { parseConfiguredVersionFromEnv } from '@owlat/shared/containerHealth';
import { writeOwnerOnlyFile } from '@owlat/shared/ownerOnlyFile';
import { exec, OWLAT_DIR } from './http.js';
import { oneLine } from './rollout.js';
import { freeBytes } from './storage.js';
import {
	COPY_TIMEOUT_MS,
	discardSnapshot,
	helperPlumbing,
	helperRun,
	markSnapshot,
	readSnapshot,
	sha256File,
	SNAPSHOT_DIR,
	SNAPSHOT_FILES,
	statefulContainers,
	writeSnapshot,
	type Plumbing,
	type Snapshot,
	type SnapshotMount,
	type SnapshotStep,
} from './snapshot.js';

/** Room left on the disk after the copy, so the stack can keep writing. */
const FREE_SPACE_MARGIN_BYTES = 512 * 1024 ** 2;

/**
 * Whether `.env` turns the snapshot off (`OWLAT_UPDATE_SNAPSHOT=off`), for a
 * host without the disk to hold a copy of its database. Read from the file the
 * operator edits, not this process's environment, so it needs no recreate.
 */
function snapshotsDisabled(envText: string): boolean {
	const value = envText.match(/^\s*OWLAT_UPDATE_SNAPSHOT\s*=\s*["']?([A-Za-z0-9]*)["']?\s*$/m)?.[1];
	return value !== undefined && ['off', '0', 'false', 'no'].includes(value.toLowerCase());
}

/** Bytes each source holds, measured by a helper (the updater cannot see into volumes). */
async function measure(
	image: string,
	mounts: SnapshotMount[]
): Promise<number | { error: string }> {
	if (mounts.length === 0) return 0;
	const binds = mounts.map((mount, i) => `${mount.source}:/m${i}:ro`);
	const du = await exec(
		'docker',
		helperRun(image, binds, 'du', ['-sk', ...mounts.map((_, i) => `/m${i}`)]),
		OWLAT_DIR
	);
	if (!du.ok) return { error: `cannot measure the data to copy: ${oneLine(du.stderr)}` };
	return du.stdout
		.split('\n')
		.map((line) => Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10))
		.filter(Number.isFinite)
		.reduce((sum, kib) => sum + kib * 1024, 0);
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

interface CaptureOptions {
	targetVersion: string | null;
	signal: AbortSignal;
}

type CaptureResult =
	| { kind: 'taken'; snapshot: Snapshot; step: SnapshotStep }
	| { kind: 'skipped'; step: SnapshotStep }
	| { kind: 'refused'; status: number; step: SnapshotStep };

/**
 * Take the snapshot, replacing the previous one. Never leaves `convex` or
 * `redis` stopped: the containers it paused are started again whether the
 * copy finished, failed or was cut short by a shutdown.
 */
export async function captureSnapshot(options: CaptureOptions): Promise<CaptureResult> {
	const step = 'snapshot';
	const refuse = (status: number, reason: string): CaptureResult => ({
		kind: 'refused',
		status,
		step: { step, ok: false, stdout: '', stderr: reason },
	});

	let envText = '';
	try {
		envText = await readFile(join(OWLAT_DIR, '.env'), 'utf-8');
	} catch {
		// No `.env` to read the switch from: the snapshot stays on.
	}
	if (snapshotsDisabled(envText)) {
		return {
			kind: 'skipped',
			step: {
				step,
				ok: true,
				stdout:
					'No snapshot taken (OWLAT_UPDATE_SNAPSHOT=off in .env): a release that fails is not rolled back.',
				stderr: '',
			},
		};
	}

	const previous = readSnapshot();
	if (previous?.state === 'restoring') {
		return refuse(
			409,
			'A rollback to the snapshot from before an earlier update did not finish, so the stack may be ' +
				'running on half-restored data. Nothing was changed. Run `owlat rollback` on the host to finish it, then update again.'
		);
	}

	const plumbing = await helperPlumbing();
	if (!plumbing) {
		return refuse(
			500,
			'Cannot read the install directory this updater is mounted from, so it cannot take the snapshot an ' +
				'update rolls back to. Nothing was changed. Set OWLAT_UPDATE_SNAPSHOT=off in .env to update without one.'
		);
	}
	const found = await statefulContainers();
	if ('error' in found) {
		return refuse(500, `Cannot take the snapshot: ${found.error}. Nothing was changed.`);
	}

	const mounts: SnapshotMount[] = [];
	for (const container of found) {
		for (const mount of container.mounts) {
			if (mounts.some((known) => known.source === mount.source)) continue;
			mounts.push({ service: container.service, ...mount, payload: `m${mounts.length}.tar` });
		}
	}

	const size = await measure(plumbing.image, mounts);
	if (typeof size !== 'number') {
		return refuse(500, `Cannot take the snapshot: ${size.error}. Nothing was changed.`);
	}
	// The previous snapshot is replaced, so the room it takes counts as free.
	const replaced = (previous?.mounts ?? []).reduce((sum, mount) => sum + (mount.bytes ?? 0), 0);
	const measuredFree = freeBytes();
	const free = measuredFree === null ? null : measuredFree + replaced;
	if (free !== null && free < size + FREE_SPACE_MARGIN_BYTES) {
		return refuse(
			507,
			`Not enough disk space for the snapshot an update rolls back to: it needs ${gib(size)} plus ` +
				`${gib(FREE_SPACE_MARGIN_BYTES)} to spare, and ${gib(free)} is free. Nothing was changed. Free ` +
				'some space, or set OWLAT_UPDATE_SNAPSHOT=off in .env to update without a snapshot.'
		);
	}
	await discardSnapshot();

	let snapshot: Snapshot = {
		id: `snap-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
		takenAt: Date.now(),
		state: 'capturing',
		fromVersion: parseConfiguredVersionFromEnv(envText) ?? null,
		targetVersion: options.targetVersion,
		paused: found.filter((c) => c.running).map((c) => c.id),
		mounts,
		files: [],
	};

	try {
		mkdirSync(join(SNAPSHOT_DIR, 'config'), { recursive: true, mode: 0o700 });
		mkdirSync(join(SNAPSHOT_DIR, 'data'), { recursive: true, mode: 0o700 });
		writeSnapshot(snapshot);
		for (const file of SNAPSHOT_FILES) {
			let content: string;
			try {
				content = await readFile(join(OWLAT_DIR, file), 'utf-8');
			} catch {
				continue;
			}
			await writeOwnerOnlyFile(join(SNAPSHOT_DIR, 'config', file), content);
			snapshot.files.push(file);
		}
	} catch (err) {
		await discardSnapshot();
		return refuse(500, `Cannot write the snapshot: ${errorMessage(err)}. Nothing was changed.`);
	}

	const startedAt = Date.now();
	const copied = await copyPaused(plumbing, snapshot, options.signal);
	const pausedFor = Math.round((Date.now() - startedAt) / 1000);
	if (!copied.ok) {
		await discardSnapshot();
		return refuse(500, `Cannot take the snapshot: ${copied.reason} Nothing was changed.`);
	}

	try {
		for (const mount of snapshot.mounts) {
			const path = join(SNAPSHOT_DIR, 'data', mount.payload);
			mount.bytes = statSync(path).size;
			mount.sha256 = await sha256File(path);
		}
		snapshot = markSnapshot({ ...snapshot, paused: [] }, 'armed');
	} catch (err) {
		await discardSnapshot();
		return refuse(500, `Cannot read the snapshot back: ${errorMessage(err)}. Nothing was changed.`);
	}

	const what = snapshot.mounts.map((m) => `${m.source} (${gib(m.bytes ?? 0)})`);
	return {
		kind: 'taken',
		snapshot,
		step: {
			step,
			ok: true,
			stdout:
				`Snapshot ${snapshot.id} taken of ${[...what, snapshot.files.join(', ')].filter(Boolean).join(', ')}` +
				(copied.paused ? `; convex and redis were paused for ${pausedFor}s.` : '.'),
			stderr: '',
		},
	};
}

/**
 * Stop the running stateful containers, copy every mount, and start them
 * again. The restart takes no signal, and runs however the copy ended
 * (`exec` never throws): a shutdown must not leave them stopped.
 */
async function copyPaused(
	plumbing: Plumbing,
	snapshot: Snapshot,
	signal: AbortSignal
): Promise<{ ok: true; paused: boolean } | { ok: false; reason: string }> {
	const paused = snapshot.paused;
	const copied = await copyMounts(plumbing, snapshot, signal);
	if (paused.length === 0) return copied.ok ? { ok: true, paused: false } : copied;

	const started = await exec('docker', ['start', ...paused], OWLAT_DIR);
	if (!started.ok) {
		const reason =
			`convex and redis could not be started again after the copy (${oneLine(started.stderr)}); ` +
			'on the host, `docker compose up -d convex redis` starts them.';
		console.error('[update]', reason);
		return { ok: false, reason: copied.ok ? reason : `${copied.reason} Then ${reason}` };
	}
	return copied.ok ? { ok: true, paused: true } : copied;
}

async function copyMounts(
	plumbing: Plumbing,
	snapshot: Snapshot,
	signal: AbortSignal
): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (snapshot.paused.length > 0) {
		const stopped = await exec('docker', ['stop', ...snapshot.paused], OWLAT_DIR, { signal });
		if (!stopped.ok) {
			return { ok: false, reason: `stopping convex and redis failed: ${oneLine(stopped.stderr)}.` };
		}
	}
	for (const mount of snapshot.mounts) {
		const copy = await exec(
			'docker',
			helperRun(
				plumbing.image,
				[`${mount.source}:/source:ro`, `${plumbing.hostSnapshotDir}:/snapshot`],
				'tar',
				['-cf', `/snapshot/data/${mount.payload}`, '-C', '/source', '.']
			),
			OWLAT_DIR,
			{ signal, timeoutMs: COPY_TIMEOUT_MS }
		);
		if (!copy.ok) {
			return { ok: false, reason: `copying ${mount.source} failed: ${oneLine(copy.stderr)}.` };
		}
	}
	return { ok: true };
}

/**
 * Settle a capture the previous process never finished: start what it paused
 * and drop the partial copy. Run once at startup.
 */
export async function recoverInterruptedCapture(): Promise<void> {
	const snapshot = readSnapshot();
	if (snapshot?.state !== 'capturing') return;
	if (snapshot.paused.length > 0) {
		const started = await exec('docker', ['start', ...snapshot.paused], OWLAT_DIR);
		if (!started.ok) {
			console.error('[update] could not start the services a snapshot paused:', started.stderr);
		}
	}
	await discardSnapshot();
	console.error('[update] discarded a snapshot the previous updater stopped taking');
}
