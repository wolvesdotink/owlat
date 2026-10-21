/**
 * Liveness heartbeat for the container healthcheck.
 *
 * The worker pulls work and has no listener a probe could ask, so it rewrites
 * one file on a timer instead, and the compose healthcheck reads the file's
 * age. The timer runs on the worker's event loop, independent of the poll loop:
 * an idle worker and one waiting minutes on a sandboxed task both keep it
 * fresh, while a process whose event loop has stopped turning lets it go stale.
 *
 * The file lives on the container's /tmp tmpfs (the rootfs is read-only), so a
 * restart never inherits a fresh-looking heartbeat from the previous run.
 */
import { lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Only the worker's uid may write here. /tmp is shared with the sandboxed task
 * processes, so a name directly in /tmp could be planted by a task: a directory
 * at the staging name makes every write fail and a working worker reads as
 * unhealthy, and a fresh file at the target keeps a stalled one looking alive.
 */
export const HEARTBEAT_DIR = '/tmp/owlat-code-worker';

/** Read by the `code-worker` healthcheck in both compose templates. */
export const HEARTBEAT_PATH = `${HEARTBEAT_DIR}/heartbeat`;

/**
 * How often the file is rewritten. The healthcheck allows two minutes, enough
 * to ride out the synchronous `chown -R` of a large task checkout.
 */
export const HEARTBEAT_INTERVAL_MS = 10_000;

interface HeartbeatOptions {
	readonly path?: string;
	readonly intervalMs?: number;
	readonly now?: () => number;
	readonly write?: (path: string, contents: string) => void;
	readonly log?: (message: string) => void;
	readonly prepare?: (dir: string) => void;
}

/**
 * Create `dir` with mode 0700, owned by the worker. This runs before the first
 * task starts, so no task can have created it first; a path that already exists
 * and is not such a directory (a symlink, a file, a directory with any group or
 * other access, or one another uid owns) is refused rather than written through.
 */
export function prepareHeartbeatDir(dir: string): void {
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
	const stat = lstatSync(dir);
	const uid = process.getuid?.();
	const ownedByWorker = uid === undefined || stat.uid === uid;
	if (!stat.isDirectory() || !ownedByWorker || (stat.mode & 0o077) !== 0) {
		throw new Error(`Heartbeat directory ${dir} is not a private directory of the worker`);
	}
}

/**
 * Replace the file in one rename, so the probe never reads a half-written one.
 * The staging name sits beside the target, in the same private directory.
 */
export function writeHeartbeatFile(path: string, contents: string): void {
	const staged = `${path}.tmp`;
	writeFileSync(staged, contents);
	renameSync(staged, path);
}

/**
 * Prepare the file's directory, then beat once now and every `intervalMs`.
 * Returns a stop function. Throws if the directory cannot be made private, so
 * the worker stops at boot instead of running with a heartbeat a task controls.
 *
 * A failed write is logged when it starts failing and when it recovers, not on
 * every tick: the healthcheck already reports the outage, and a full /tmp
 * would otherwise add a log line every ten seconds.
 */
export function startHeartbeat(options: HeartbeatOptions = {}): () => void {
	const path = options.path ?? HEARTBEAT_PATH;
	const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
	const now = options.now ?? Date.now;
	const write = options.write ?? writeHeartbeatFile;
	const log = options.log ?? (() => {});
	const prepare = options.prepare ?? prepareHeartbeatDir;
	let failing = false;

	prepare(dirname(path));

	const beat = () => {
		try {
			write(path, `${new Date(now()).toISOString()}\n`);
			if (failing) log(`Heartbeat file ${path} is writable again`);
			failing = false;
		} catch (error) {
			if (!failing) {
				const reason = error instanceof Error ? error.message : String(error);
				log(`Could not write heartbeat file ${path}: ${reason}`);
			}
			failing = true;
		}
	};

	beat();
	const timer = setInterval(beat, intervalMs);
	// The poll loop decides when the process ends; the heartbeat never holds it.
	timer.unref();
	return () => clearInterval(timer);
}
