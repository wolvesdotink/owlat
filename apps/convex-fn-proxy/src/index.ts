import { createServer } from 'node:http';
import { createProxyHandler, PORT, resolveConfig } from './proxy.js';

// Route both crash channels through this process's own log stream. Node ≥15
// already ends the process on either one, so what changes is where the event
// lands: the default handler writes a raw trace to stderr, outside the format
// everything else here logs in. Both are treated the same, because a rejection
// nobody handled is the same failure an uncaught throw is, one await later.
//
// This block duplicates `@owlat/shared/nodeShutdown` only because that import
// would mean declaring the dependency, and declaring it moves bun.lock, which
// this change may not touch. The image itself would be fine with it: the
// Dockerfile installs from the workspace root and `bun build` inlines whatever
// the entrypoint imports, so a workspace dep adds no node_modules at runtime.
// Collapse this onto the shared helper the next time bun.lock is in play.
const fatal = (message: string, detail: unknown) => {
	console.error(`[convex-fn-proxy] ${message}`, detail);
	process.exit(1);
};
process.on('uncaughtException', (err) => fatal('uncaught exception — exiting', err));
process.on('unhandledRejection', (reason) => fatal('unhandled rejection — exiting', reason));

// Fail closed at boot: resolveConfig throws if the upstream URL, the injected
// admin key, or the worker token is missing.
const config = resolveConfig();
const server = createServer(createProxyHandler(config));

// Graceful stop. Without this, `docker compose restart` killed the proxy
// mid-request and the code-worker saw a socket hang up instead of the Convex
// answer it was waiting on. `close()` stops accepting and resolves once the
// in-flight requests have been answered; idle keep-alive sockets are closed
// explicitly, because otherwise a worker connection parked between polls would
// hold the callback until the watchdog fired.
//
// 9s, just inside Docker's default 10s stop grace period (this service declares
// no stop_grace_period of its own).
const SHUTDOWN_DEADLINE_MS = 9_000;
let shuttingDown = false;

const shutdown = (signal: NodeJS.Signals) => {
	if (shuttingDown) return;
	shuttingDown = true;
	console.info(`[convex-fn-proxy] ${signal} received — draining`);

	const watchdog = setTimeout(() => {
		console.error('[convex-fn-proxy] drain deadline exceeded — forcing exit');
		process.exit(1);
	}, SHUTDOWN_DEADLINE_MS);
	watchdog.unref();

	server.close(() => {
		clearTimeout(watchdog);
		console.info('[convex-fn-proxy] drained — exiting');
		process.exit(0);
	});
	server.closeIdleConnections();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
	console.info(`Convex function-allowlist proxy listening on port ${PORT}`);
});
