/**
 * Fire-and-forget close for an `@owlat/smtp-listener` during graceful shutdown.
 *
 * `SmtpListener.close()` returns a promise that REJECTS with an
 * `ERR_SERVER_NOT_RUNNING`-class error when the listener never bound — a state
 * boot deliberately tolerates for the port-25 bounce listener (needs root) and
 * the 587/465 submission listeners (port may need root), which warn-and-continue
 * at startup. If that rejection is left un-awaited it surfaces as an unhandled
 * promise rejection and crashes the process mid-drain, aborting the graceful
 * queue drain. So: `void` the promise and swallow the rejection into a log line,
 * exactly as the shutdown path needs for every SMTP listener it closes.
 *
 * `close` is taken as a thunk so a listener that was never constructed (an
 * optional/disabled server) is simply not passed in by the caller.
 */
export function closeListenerSafely(
	close: () => Promise<void>,
	label: string,
	log: { error: (obj: unknown, msg: string) => void }
): void {
	void close().catch((err) => log.error({ err }, label));
}
