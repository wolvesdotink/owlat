/**
 * Graceful shutdown plugin (P5.3 / S Phase 5).
 *
 * Docker Compose sends SIGTERM, waits `stop_grace_period` (45s in our
 * templates), then SIGKILLs. Nuxt/Nitro's default handler closes the HTTP
 * server on SIGTERM, which is already correct — this plugin adds:
 *
 *   1. A hard-exit watchdog so a stuck close() never blows past the
 *      grace period (Docker's SIGKILL is strictly worse because it skips
 *      any cleanup that already happened).
 *   2. A single structured log line on signal receipt for log sinks.
 *
 * We deliberately DON'T try to intercept in-flight HTTP requests here —
 * the web app's Convex queries are idempotent, so losing a few on
 * shutdown is acceptable. If we ever add long-running server-side jobs,
 * drain them in this handler before the process.exit.
 */

// Must stay BELOW every web service's `stop_grace_period` (45s in both
// docker-compose.yml and infra/templates/docker-compose.vps.yml) so the watchdog
// fires before Docker's SIGKILL.
const HARD_EXIT_MS = 40_000;

export default defineNitroPlugin(() => {
	// Guard against plugin-reload in dev mode running this twice.
	const g = globalThis as typeof globalThis & { __owlatGracefulShutdownRegistered?: boolean };
	if (g.__owlatGracefulShutdownRegistered) return;
	g.__owlatGracefulShutdownRegistered = true;

	let shuttingDown = false;

	const handle = (signal: NodeJS.Signals) => {
		if (shuttingDown) return;
		shuttingDown = true;

		// eslint-disable-next-line no-console
		console.log(
			JSON.stringify({
				event: 'web_shutdown_signal',
				signal,
				timestamp: new Date().toISOString(),
			}),
		);

		// Hard-exit if cleanup hangs — Docker will SIGKILL us at 45s anyway.
		const watchdog = setTimeout(() => {
			// eslint-disable-next-line no-console
			console.error(
				JSON.stringify({
					event: 'web_shutdown_forced',
					deadlineMs: HARD_EXIT_MS,
					timestamp: new Date().toISOString(),
				}),
			);
			process.exit(1);
		}, HARD_EXIT_MS);
		watchdog.unref();
	};

	process.on('SIGTERM', handle);
	process.on('SIGINT', handle);
});
