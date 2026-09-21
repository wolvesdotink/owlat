/**
 * Signal and crash handling for the long-running Node sidecars.
 *
 * NODE-ONLY: installs `process` signal handlers. Exposed via the
 * `@owlat/shared/nodeShutdown` subpath ONLY — it must never be re-exported from
 * the `.` barrel, which has to stay browser-safe.
 *
 * Every sidecar has the same two obligations and kept getting only the ones its
 * author remembered:
 *
 *  - `docker compose restart/down` sends SIGTERM and SIGKILLs after the
 *    stop_grace_period. A process with no SIGTERM handler dies on the spot,
 *    mid-request. For the updater that is not a dropped response but a
 *    DIVERGED HOST: its endpoints write `.env`, the compose override and
 *    `.owlat-flags.json` and only then reconcile the running containers, so a
 *    signal taken between the two halves leaves the configuration describing a
 *    stack that is not running.
 *  - An `uncaughtException` or an unhandled rejection reaches no logger. Node
 *    ≥15 already ends the process on both (every image is node:26), so the
 *    process did die — it died printing a raw trace to stderr, outside the
 *    structured log stream the rest of the service writes and the collector
 *    indexes. Routing both channels through the app's own logger is the gain.
 *
 * So both live here, with the drain bounded by a watchdog: hanging past the
 * grace period earns a SIGKILL anyway, which is strictly worse because it also
 * discards the cleanup that already happened.
 */

/**
 * Log sink. The sidecars disagree about logging (pino in imap/mail-sync/mta,
 * plain console elsewhere), so each caller adapts its own rather than this
 * module picking a winner and dragging pino into `@owlat/shared`.
 */
export type ShutdownLog = (message: string, detail?: unknown) => void;

/** The subset of `http.Server` / `@hono/node-server` this module needs. */
export interface ClosableServer {
	close(callback?: (err?: Error) => void): unknown;
	/** Present on node:http servers since 18.2; absent on some wrappers. */
	closeIdleConnections?(): void;
}

export interface ShutdownOptions {
	/** Stopped first, so no new connection is accepted once a signal lands. */
	server?: ClosableServer;
	/** Runs after in-flight critical sections settle: close clients, flush. */
	drain?: () => Promise<void>;
	/**
	 * Hard-exit deadline for the whole drain. Keep it comfortably under the
	 * service's compose `stop_grace_period` so the watchdog, not Docker, is what
	 * ends a wedged shutdown.
	 */
	timeoutMs: number;
	log: ShutdownLog;
	/** Seam for tests; defaults to `process.exit`. */
	exit?: (code: number) => void;
	signals?: NodeJS.Signals[];
}

export interface ShutdownHandle {
	isShuttingDown(): boolean;
	/**
	 * Run `fn` as a critical section. A signal arriving while one is in flight
	 * stops accepting new work but waits for the section to finish, so a
	 * multi-step sequence is never cut between two of its writes.
	 *
	 * Sections started AFTER a signal still run: by then the listener is closed,
	 * so the only callers left are requests already accepted, and finishing
	 * their sequence is the whole point. The watchdog bounds the total.
	 */
	critical<T>(fn: () => Promise<T>): Promise<T>;
	/** Trigger the same path a signal would; exported for tests. */
	shutdown(signal: string): Promise<void>;
}

export function installShutdown(options: ShutdownOptions): ShutdownHandle {
	const { server, drain, timeoutMs, log } = options;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[]);

	const inFlight = new Set<Promise<unknown>>();
	let shuttingDown = false;

	const critical = <T>(fn: () => Promise<T>): Promise<T> => {
		const promise = fn();
		// Track the settled shape, never the caller's promise: an awaited-later
		// rejection tracked here would otherwise become an unhandled rejection
		// the moment the drain's `allSettled` is the first to touch it.
		const tracked = promise.then(
			() => undefined,
			() => undefined
		);
		inFlight.add(tracked);
		void tracked.finally(() => inFlight.delete(tracked));
		return promise;
	};

	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) {
			log('shutdown already in progress — ignoring duplicate signal', { signal });
			return;
		}
		shuttingDown = true;
		log('shutdown signal received', { signal });

		// Deliberately NOT unref'd. An unref'd watchdog stops holding the loop
		// open, so a drain that wedges with nothing else pending lets the process
		// fall out of the loop and exit 0 — a silent success for a shutdown that
		// never finished. Held ref'd, the wedge ends at the deadline with a log
		// line and a non-zero code, which is the outcome an operator can see.
		const watchdog = setTimeout(() => {
			log('shutdown deadline exceeded — forcing exit', { timeoutMs });
			exit(1);
		}, timeoutMs);

		// Stop accepting immediately, but keep the promise: `close()` fires its
		// callback only once the last in-flight response has been written, and
		// exiting before that truncates the response the client is still reading.
		// Idle keep-alive sockets carry no request and would otherwise hold the
		// callback for their whole timeout, so they are cut first.
		let closed: Promise<void> | undefined;
		if (server) {
			closed = new Promise<void>((resolve) => {
				try {
					server.close((err) => {
						if (err) log('server close failed', err);
						resolve();
					});
				} catch (err) {
					// Some listeners reject/throw when they never bound at all.
					log('server close failed', err);
					resolve();
				}
			});
			server.closeIdleConnections?.();
		}

		// A critical section may start another one (the updater's apply sequence
		// does), so drain until the set is empty rather than snapshotting once.
		while (inFlight.size > 0) {
			await Promise.allSettled([...inFlight]);
		}

		if (closed) await closed;

		if (drain) {
			try {
				await drain();
			} catch (err) {
				log('drain failed', err);
			}
		}

		clearTimeout(watchdog);
		log('shutdown complete', { signal });
		exit(0);
	};

	for (const signal of signals) {
		process.on(signal, () => void shutdown(signal));
	}

	return {
		isShuttingDown: () => shuttingDown,
		critical,
		shutdown,
	};
}

export interface CrashHandlerOptions {
	log: ShutdownLog;
	/** Seam for tests; defaults to `process.exit`. */
	exit?: (code: number) => void;
}

/**
 * Route `uncaughtException` AND `unhandledRejection` through the app's logger,
 * then exit non-zero.
 *
 * Node ≥15 already terminates on both by default, so this does not change WHAT
 * happens to the process — it changes what an operator can find afterwards. The
 * default handler writes a raw trace to stderr and nothing else; every sidecar
 * logs structured JSON, so the one event that explains the restart was the one
 * event outside the format the log collector indexes.
 *
 * Both channels are treated identically: a rejection nobody handled is the same
 * failure an uncaught throw is, one await boundary later. Neither leaves a state
 * this process can reason about, and every sidecar runs under a compose restart
 * policy, so a process whose invariants hold is seconds away.
 *
 * One caveat for local development: `apps/mta` configures pino-pretty as a
 * transport when NODE_ENV=development, and a transport is a worker thread, so a
 * `process.exit` immediately after the write can lose the line. Production
 * builds log synchronously to stdout and do not have this problem.
 */
export function installCrashHandlers(options: CrashHandlerOptions): void {
	const { log } = options;
	const exit = options.exit ?? ((code: number) => process.exit(code));

	process.on('uncaughtException', (err) => {
		log('uncaught exception — exiting', err);
		exit(1);
	});

	process.on('unhandledRejection', (reason) => {
		log('unhandled rejection — exiting', reason);
		exit(1);
	});
}
