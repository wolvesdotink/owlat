/**
 * Process-lifecycle seam for the updater's request handlers.
 *
 * index.ts owns the real signal handling; the handlers only need to say "this
 * is a step sequence, do not cut it in half", and to hear when a shutdown has
 * begun so the work they can still back out of stops early. They reach both
 * through this module rather than an import of index.ts, which would pull the
 * listening socket into every test that mounts the request listener.
 *
 * With no handle installed — tests, and any future embedding — `critical` is a
 * transparent pass-through and `shutdownSignal` never aborts, so the handlers
 * behave identically either way.
 */
import type { ShutdownHandle } from '@owlat/shared/nodeShutdown';
import { stopRunningChildren } from './http.js';

/**
 * The updater's `stop_grace_period` in both shipped compose files
 * (docker-compose.yml, and so the release template, and
 * infra/templates/docker-compose.vps.yml; scripts/check-compose-invariants.sh
 * holds all three to this number). Docker SIGKILLs the updater this long after
 * SIGTERM, so everything below has to fit inside it.
 */
export const STOP_GRACE_SECONDS = 120;

/**
 * How long a shutdown waits for the rollout in flight. A rollout that is still
 * in a phase it can back out of (preflight, pull, convex-deploy: the running
 * stack is untouched until the compose file is promoted) stops within seconds
 * of the signal. One that has promoted the release is finishing the recreate
 * that brings the containers in line with it, and a recreate of the whole
 * stack stops each old container within its own grace period (45 s for
 * convex, web and the MTA) and waits on convex's healthcheck before starting
 * the services that depend on it. This is the budget that recreate gets.
 */
export const SHUTDOWN_DEADLINE_MS = 105_000;

/**
 * After the deadline, a child still running gets this long to stop on SIGTERM
 * before it is killed, and one more second to be collected. Deadline plus both
 * stays inside the stop grace, so the updater exits on its own terms and not
 * on Docker's SIGKILL.
 */
export const CHILD_STOP_GRACE_MS = 5_000;

let handle: ShutdownHandle | undefined;
let stopping = new AbortController();

export function setShutdownHandle(installed: ShutdownHandle | undefined): void {
	handle = installed;
	stopping = new AbortController();
}

/**
 * Pass to `installShutdown` as `onShutdown`: tells every handler holding
 * `shutdownSignal()` that the process is stopping.
 */
export function beginShutdown(): void {
	stopping.abort();
}

/**
 * Aborts the moment a shutdown begins. The cue for work that is safe to
 * abandon, and only for that: see `ExecOptions.signal` in http.ts.
 */
export function shutdownSignal(): AbortSignal {
	return stopping.signal;
}

/**
 * Mark `fn` as a critical section: a SIGTERM arriving while it runs stops the
 * listener but waits for these steps to finish.
 *
 * The endpoints that need it are the ones that write host state before acting
 * on it — /apply-profiles writes `.env`, the compose override and the flag
 * mirror and only then runs `docker compose up -d`, so a process killed
 * between two of those steps leaves the configuration describing a stack that
 * is not running.
 *
 * This only bites where the handler actually yields, which it now does for
 * every file write and every Docker command (`exec` is asynchronous). A fully
 * synchronous sequence would never let the signal handler run in the first
 * place.
 */
export function critical<T>(fn: () => Promise<T>): Promise<T> {
	return handle ? handle.critical(fn) : fn();
}

let exiting = false;

/**
 * Pass to `installShutdown` as `exit`. When the deadline fires, a Docker
 * command may still be running; it is stopped and collected before the
 * process goes, so no `docker compose` outlives the updater that was supposed
 * to report on it. The first exit code wins: a drain that finishes while the
 * deadline's exit is stopping children does not turn it into a clean one.
 */
export function exitAfterStoppingChildren(
	code: number,
	exit: (code: number) => void = (c) => process.exit(c)
): Promise<void> {
	if (exiting) return Promise.resolve();
	exiting = true;
	return stopRunningChildren(CHILD_STOP_GRACE_MS).finally(() => exit(code));
}
