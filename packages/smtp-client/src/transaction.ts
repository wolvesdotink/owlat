/**
 * The transaction layer of the in-house SMTP client.
 *
 * Sits on top of the {@link SmtpConnection} engine (which drives connect →
 * greeting → EHLO → optional STARTTLS): this file owns the QUIT teardown, the X1
 * RSET reuse boundary, and two convenience wrappers — {@link verify} for
 * connection testing and {@link sendMessage} for a one-shot send. AUTH (the SASL
 * mechanisms + the secured/loopback invariant) lives in `auth.ts`; the MAIL/RCPT/
 * DATA envelope itself (sequential + RFC 2920 PIPELINING) lives in `envelope.ts`;
 * this file composes them with connection setup.
 *
 * Every failure is a phase-tagged {@link SmtpError}: the retry taxonomy the MTA
 * builds (AMBIGUOUS_TIMEOUT never auto-retried in phase `data`/`data-final`,
 * everything earlier safely retryable) reads `.phase`/`.replyCode`/`.tlsCause` —
 * NEVER a log string. Two invariants are enforced structurally, not by policy:
 *
 *  - AUTH is refused BEFORE credentials are serialized unless the socket is
 *    `secured` or the peer is loopback (the mail-sync submission invariant, W4) —
 *    see `auth.ts`.
 *  - RCPT collects a per-recipient verdict; the transaction proceeds as long as
 *    at least one recipient was accepted, reporting the rest with their codes.
 */

import { serializeRset, serializeQuit } from './commands';
import { SmtpConnection, type SmtpConnectOptions } from './connection';
import { SmtpError, SmtpAbortError } from './errors';
import { isPositiveCompletion } from './reply';
import { errorFromReply, sendEnvelope, type EnvelopeOptions, type SendResult } from './envelope';
import { authenticate, type AuthenticateOptions, type SmtpCredentials } from './auth';

export {
	type RecipientVerdict,
	type PipeliningMode,
	type EnvelopeOptions,
	type SendResult,
	sendEnvelope,
	envelopeRequiresSmtpUtf8,
} from './envelope';

export {
	authenticate,
	type SmtpAuthMechanism,
	type SmtpPasswordCredentials,
	type SmtpOAuthCredentials,
	type SmtpCredentials,
	type AuthenticateOptions,
} from './auth';

// ── Teardown ──────────────────────────────────────────────────────────────────

/**
 * Best-effort QUIT: send the command, read the 221 acknowledgement, then close.
 * Teardown never throws — a server that drops the socket instead of replying is
 * a benign end-of-session, not a delivery failure.
 */
export async function quit(conn: SmtpConnection): Promise<void> {
	try {
		// The `'connect'` phase label is unobservable: any error here is swallowed
		// below and never escapes to a classifier, so QUIT needs no phase of its own
		// (there is no `'quit'` in the retry taxonomy). The label is inert bookkeeping.
		await conn.command(serializeQuit(), 'connect');
	} catch {
		// Swallow: the transaction already succeeded/failed on its own terms; a
		// missing 221 does not change that.
	} finally {
		conn.close();
	}
}

// ── RSET reuse boundary (X1) ────────────────────────────────────────────────────

/**
 * Abort any in-progress mail transaction with `RSET` and confirm the server's 250,
 * returning the connection to a clean pre-`MAIL` state so the SAME live socket can
 * carry the NEXT MAIL/RCPT/DATA transaction (true socket reuse — the MTA pool's X1
 * capability, W3's RSET follow-up).
 *
 * RSET is the reuse BOUNDARY: because {@link sendEnvelope} reads each reply to
 * completion (the final `data-final` reply included), the {@link SmtpConnection}'s
 * single {@link SmtpReply} reader is idle and drained before this runs, and the
 * verified 250 proves the server has flushed the prior transaction. Together they
 * guarantee no state — a leftover reply, a half-read multiline response — leaks
 * from the previous transaction into the next (the classic reuse bug class).
 *
 * A non-250 reply, or a transport error, means the socket is unhealthy: this throws
 * a phase-`mail` {@link SmtpError} (the safely-retryable, pre-DATA region) and the
 * caller MUST discard the socket — a poisoned connection is never reused.
 */
export async function resetTransaction(conn: SmtpConnection): Promise<void> {
	if (conn.hasPendingData) {
		// A reply the prior transaction left buffered — or an unsolicited line the
		// peer injected while the socket was idle — would be consumed as the RSET's
		// answer and desync every later read. Refuse to reuse a socket that is not
		// drained; the caller discards it and connects fresh.
		throw new SmtpError({
			phase: 'mail',
			message: 'connection has buffered data before RSET; refusing to reuse a non-drained socket',
			secured: conn.secured,
		});
	}
	const reply = await conn.command(serializeRset(), 'mail');
	if (!isPositiveCompletion(reply.code)) {
		throw errorFromReply('mail', `server rejected RSET with ${reply.code}`, conn.secured, reply);
	}
}

// ── One-shot wrappers ─────────────────────────────────────────────────────────

export interface AuthConfig extends AuthenticateOptions {
	credentials: SmtpCredentials;
}

export interface SendMessageOptions {
	/** How to open the connection (host/port/TLS mode/timeouts). */
	connect: SmtpConnectOptions;
	/** Credentials + mechanism/loopback policy, when the peer requires AUTH. */
	auth?: AuthConfig;
	/** The envelope + body to deliver. */
	envelope: EnvelopeOptions;
	/** Optional cancellation; aborting destroys the live socket immediately. */
	signal?: AbortSignal;
}

/** One-shot connect → (AUTH) → MAIL/RCPT/DATA → QUIT; tears down on every exit. */
export async function sendMessage(options: SendMessageOptions): Promise<SendResult> {
	const conn = await SmtpConnection.connect(options.connect);
	const abort = (): void => conn.close();
	options.signal?.addEventListener('abort', abort, { once: true });
	try {
		if (options.signal?.aborted === true) {
			conn.close();
			throw new SmtpAbortError();
		}
		if (options.auth !== undefined) {
			await authenticate(conn, options.auth.credentials, authOptions(options.auth));
		}
		const result = await sendEnvelope(conn, options.envelope);
		await quit(conn);
		return result;
	} catch (err) {
		conn.close();
		// A mid-flight abort fires `abort` → `conn.close()`, so the in-flight read
		// rejects with a phase-tagged wire SmtpError indistinguishable from a genuine
		// transient failure. When the signal is aborted, normalize BOTH abort paths to
		// a single recognizable SmtpAbortError so the retry classifier never re-enqueues
		// a cancelled send. The original wire error is kept on `cause` for logs.
		if (options.signal?.aborted === true) {
			throw err instanceof SmtpAbortError
				? err
				: new SmtpAbortError('SMTP send aborted', { cause: err });
		}
		throw err;
	} finally {
		options.signal?.removeEventListener('abort', abort);
	}
}

export interface VerifyOptions {
	/** How to open the connection. */
	connect: SmtpConnectOptions;
	/** Credentials to validate, when verifying a submission (AUTH) endpoint. */
	auth?: AuthConfig;
}

/**
 * Connection test: connect → EHLO → (AUTH) → QUIT. Resolves when the endpoint is
 * reachable and (if credentials were supplied) accepts them; rejects with a
 * phase-tagged {@link SmtpError} otherwise. No message is ever sent.
 */
export async function verify(options: VerifyOptions): Promise<void> {
	const conn = await SmtpConnection.connect(options.connect);
	try {
		if (options.auth !== undefined) {
			await authenticate(conn, options.auth.credentials, authOptions(options.auth));
		}
		await quit(conn);
	} catch (err) {
		conn.close();
		throw err;
	}
}

function authOptions(auth: AuthConfig): AuthenticateOptions {
	const opts: AuthenticateOptions = {};
	if (auth.mechanisms !== undefined) {
		opts.mechanisms = auth.mechanisms;
	}
	if (auth.loopback !== undefined) {
		opts.loopback = auth.loopback;
	}
	return opts;
}
