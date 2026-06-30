/**
 * Wait for the docker compose stack to become reachable.
 *
 * The `quickstart` command brings the stack up with `docker compose up -d`
 * and then needs to wait until the Convex backend's HTTP endpoint is
 * accepting requests before posting `/seed/admin` and `/seed/demo`.
 *
 * Convex prints `Convex backend is ready` once functions are deployed, but
 * we don't want to parse logs — polling the `/version` HTTP endpoint is
 * simpler and deterministic.
 */

export interface WaitOptions {
	url: string;
	timeoutMs?: number;
	/** How often to retry the probe (default 1000ms). */
	intervalMs?: number;
	/** Per-request abort timeout (default 10000ms). Decoupled from intervalMs
	 *  so a slow cold-start `/version` (which may take several seconds to
	 *  return on the first probe) doesn't trigger an AbortError every poll. */
	requestTimeoutMs?: number;
	onTick?: (elapsedMs: number) => void;
}

export async function waitForUrl(opts: WaitOptions): Promise<void> {
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const intervalMs = opts.intervalMs ?? 1_000;
	const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
	const start = Date.now();

	while (true) {
		const elapsed = Date.now() - start;
		if (elapsed >= timeoutMs) {
			throw new Error(
				`Timed out after ${(timeoutMs / 1000).toFixed(0)}s waiting for ${opts.url}`,
			);
		}

		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), requestTimeoutMs);
		try {
			const resp = await fetch(opts.url, { signal: ctrl.signal });
			// Any successful HTTP response means the server is up.
			// Convex returns 200 on /version; an unrouted path returns 404 —
			// either way the backend is reachable.
			if (resp.status >= 200 && resp.status < 500) return;
		} catch {
			// Not reachable yet — keep polling.
		} finally {
			// Always clear the per-request timer — on the common
			// connection-refused path the fetch rejects and the timer would
			// otherwise stay pending (leaking a handle each poll).
			clearTimeout(t);
		}

		opts.onTick?.(elapsed);
		await sleep(intervalMs);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
