/**
 * Process-lifecycle seam for the updater's request handlers.
 *
 * index.ts owns the real signal handling; the handlers only need to say "this
 * is a step sequence, do not cut it in half". They reach that through this
 * module rather than an import of index.ts, which would pull the listening
 * socket into every test that mounts the request listener.
 *
 * With no handle installed — tests, and any future embedding — `critical` is a
 * transparent pass-through, so the handlers behave identically either way.
 */
import type { ShutdownHandle } from '@owlat/shared/nodeShutdown';

let handle: ShutdownHandle | undefined;

export function setShutdownHandle(installed: ShutdownHandle | undefined): void {
	handle = installed;
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
 * This only bites where the handler actually yields. A fully synchronous
 * sequence never lets the signal handler run in the first place, which is why
 * applyProfiles.ts uses `node:fs/promises` like the rest of the endpoints do;
 * and the `exec` calls are execFileSync, so the container-reconciling half of
 * each endpoint still blocks the loop for its whole duration.
 */
export function critical<T>(fn: () => Promise<T>): Promise<T> {
	return handle ? handle.critical(fn) : fn();
}
