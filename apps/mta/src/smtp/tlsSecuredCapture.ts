/**
 * Per-send TLS secured-state capture for the outbound SMTP transport.
 *
 * nodemailer (`SMTPTransport`, no `pool:true`) opens a FRESH connection for every
 * `sendMail` and tears it down afterwards, but it never reports back to the
 * caller whether that connection ended up encrypted. The `info` object carries
 * `response`/`messageId`/`accepted` but NO secured flag, and the per-send
 * `SMTPConnection` is internal — there is no public `secure` event on the
 * `Transporter`. So a plaintext delivery to an MX that does not advertise
 * STARTTLS (opportunistic TLS, `requireTLS:false`) resolves with no error and is
 * indistinguishable, at the public API, from an encrypted one.
 *
 * The one signal nodemailer DOES surface is its structured logger. During the
 * connect handshake the `SMTPConnection` logs, at `tnx:'smtp'`, exactly one of:
 *   - "Connection upgraded with STARTTLS"          → session is encrypted
 *   - "Failed STARTTLS upgrade, continuing unencrypted" (opportunisticTLS) → cleartext
 *   - (no STARTTLS log at all)                      → MX did not advertise STARTTLS → cleartext
 * and for implicit-TLS (port 465, `secure:true`) the socket is encrypted from
 * the first byte (no STARTTLS log, but `_socket.encrypted` is true).
 *
 * We attach this logger to every pooled transport and run each `sendMail` inside
 * an {@link AsyncLocalStorage} scope, so the upgrade log is attributed to the
 * exact in-flight call that produced it — deterministic even when several sends
 * to the same MX run concurrently on one transport. The sender reads the
 * captured state and records TLS-RPT `success` for an encrypted session or
 * `starttls-not-supported` for a cleartext one (RFC 8460 result types), instead
 * of recording `success` unconditionally and overstating TLS coverage.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger as NodemailerLogger } from 'nodemailer/lib/shared/index.js';

/** Mutable per-send capture cell carried through the async context. */
interface SecuredCapture {
	/** True once the connection negotiated TLS (STARTTLS upgrade or implicit TLS). */
	secured: boolean;
}

const securedStore = new AsyncLocalStorage<SecuredCapture>();

/** Did this log line announce a successful STARTTLS upgrade? (nodemailer SMTPConnection) */
function isStartTlsUpgradeLog(data: unknown, message: unknown): boolean {
	const isSmtpTnx =
		typeof data === 'object' && data !== null && (data as { tnx?: unknown }).tnx === 'smtp';
	return isSmtpTnx && typeof message === 'string' && message.includes('upgraded with STARTTLS');
}

/**
 * A nodemailer logger that records, into the active per-send capture cell, when
 * the connection upgrades to TLS. All other log lines are dropped (the MTA has
 * its own pino logger; nodemailer's chatter is noise). Outside a send scope the
 * logger is inert.
 */
export const securedCaptureLogger: NodemailerLogger = {
	level() {},
	trace() {},
	debug() {},
	error() {},
	fatal() {},
	warn() {},
	info(...params: unknown[]) {
		// nodemailer calls each level as `info(data, message, ...args)`.
		const [data, message] = params;
		if (isStartTlsUpgradeLog(data, message)) {
			const cell = securedStore.getStore();
			if (cell) cell.secured = true;
		}
	},
};

/**
 * Run `fn` (one `sendMail`) inside a fresh secured-capture scope and report
 * whether the underlying connection ended up encrypted.
 *
 * @param initiallySecured seed the cell true for an implicit-TLS transport
 *   (`secure:true` / port 465), where the socket is encrypted before any
 *   STARTTLS step and so emits no upgrade log.
 */
export async function withSecuredCapture<T>(
	initiallySecured: boolean,
	fn: () => Promise<T>,
): Promise<{ result: T; secured: boolean }> {
	const cell: SecuredCapture = { secured: initiallySecured };
	const result = await securedStore.run(cell, fn);
	return { result, secured: cell.secured };
}
