/**
 * The MTA's "stop taking new work" step, run the moment a shutdown signal lands.
 *
 * `installShutdown` waits for the HTTP server's `close()` callback before it
 * runs `drain`, and that callback fires only once every HTTP connection has
 * ended. Clearing the cron intervals, stopping the heartbeat and closing the SMTP
 * listeners must not wait behind that: until they run, a leader keeps starting
 * DNSBL and warming passes, the heartbeat keeps claiming liveness and the SMTP
 * ports keep accepting mail for a process that is going away. So index.ts passes
 * this as `onShutdown`, which runs synchronously at the signal, and keeps only
 * the work that has to wait (worker drain, pool, leadership, Redis) in `drain`.
 */
import { closeListenerSafely } from './closeListenerSafely.js';

export interface IntakeHandles {
	/** Every periodic job; cleared so no new pass starts during the drain. */
	intervals: ReadonlyArray<NodeJS.Timeout>;
	/** Synchronous stops: the bounce TLS reloader, the worker heartbeat. */
	stops: ReadonlyArray<() => void>;
	/** SMTP listeners with the log line for a failed close; unset ones are skipped. */
	listeners: ReadonlyArray<
		readonly [listener: { close(): Promise<void> } | null | undefined, failureMessage: string]
	>;
	log: { error: (obj: unknown, msg: string) => void };
}

export function stopIntake({ intervals, stops, listeners, log }: IntakeHandles): void {
	for (const interval of intervals) clearInterval(interval);
	for (const stop of stops) stop();
	// SmtpListener.close() REJECTS with ERR_SERVER_NOT_RUNNING when a listener
	// never bound, which boot tolerates (port 25 / 587 / 465 may need root).
	// closeListenerSafely voids and logs each rejection.
	for (const [listener, message] of listeners) {
		if (listener) closeListenerSafely(() => listener.close(), message, log);
	}
}
