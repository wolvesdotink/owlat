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
import { renameSync, writeFileSync } from 'node:fs';

/** Read by the `code-worker` healthcheck in both compose templates. */
export const HEARTBEAT_PATH = '/tmp/owlat-code-worker.heartbeat';

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
}

/**
 * Replace the file in one rename, so the probe never reads a half-written one.
 * The staging name sits beside the target, on the same filesystem.
 */
export function writeHeartbeatFile(path: string, contents: string): void {
	const staged = `${path}.tmp`;
	writeFileSync(staged, contents);
	renameSync(staged, path);
}

/**
 * Beat once now and then every `intervalMs`. Returns a stop function.
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
	let failing = false;

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
