/**
 * SASL AUTH for the SMTP listener: PLAIN and LOGIN (RFC 4954), with a strict
 * "no auth oracle" rule.
 *
 * D6: AUTH is refused before TLS (`requireTls`), and EVERY failure — an
 * unsupported mechanism, malformed base64, a client cancel (`*`), or rejected
 * credentials — is byte-identical from the client's point of view. The command
 * loop emits ONE generic `535 5.7.8` for any failure and one `235 2.7.0` on
 * success, so a probe cannot tell which stage or which credential was wrong.
 *
 * The backend check is a single injected {@link SmtpAuthConfig.authenticate}
 * hook. It is invoked at most once per AUTH attempt, and only after a
 * well-formed credential pair has been collected — protocol-level failures
 * short-circuit without touching the backend, preserving the throttle/record
 * call pattern of the listener it replaces.
 *
 * DIVERGENCES FROM smtp-server (signed off — the no-oracle rule + real enhanced
 * status codes; all intentional, pinned by `auth.test.ts`, NOT silent):
 *
 *  - Pre-TLS AUTH is refused with `530 5.7.0` (encryption required, RFC 4954 §4)
 *    where smtp-server replies `538`. `530 5.7.0` is the correct modern code.
 *  - An unsupported mechanism, a client cancel (`*`), and malformed base64 all
 *    fail with the SAME `535 5.7.8` as rejected credentials — smtp-server leaks
 *    the stage via `504` (bad mechanism) / `501` (bad base64 / cancel). Collapsing
 *    them to one reply is the deliberate no-oracle invariant (D6): the client
 *    cannot tell which stage or which field was wrong.
 *  - The failure text is `535 5.7.8 Authentication credentials invalid` (a real
 *    enhanced status code) rather than smtp-server's `535 Error: Authentication
 *    failed`.
 */

import type { MutableSmtpSession, SmtpReply, SmtpSession } from './types.js';
import { Reply } from './reply.js';

/** SASL mechanisms this listener speaks. */
export type SaslMechanism = 'PLAIN' | 'LOGIN';

/** A collected credential pair handed to the backend check. */
export interface SmtpAuthCredentials {
	username: string;
	password: string;
}

/** Verdict from {@link SmtpAuthConfig.authenticate}. */
export type SmtpAuthOutcome = { ok: true; user: string } | { ok: false };

/**
 * AUTH configuration. `authenticate` is the ONLY place a secret is checked; it
 * receives the session so a caller can attach typed state (replacing the old
 * `sessionAuth` WeakMap) and owns its own throttle / failure-recording.
 */
export interface SmtpAuthConfig<S = unknown, T = unknown> {
	/** Advertised + accepted mechanisms, in EHLO order. */
	mechanisms: readonly SaslMechanism[];
	/** Refuse AUTH until the channel is TLS (RFC 4954 §4). */
	requireTls: boolean;
	/** Backend credential check. Invoked at most once per attempt. */
	authenticate: (
		credentials: SmtpAuthCredentials,
		session: SmtpSession<S, T>
	) => Promise<SmtpAuthOutcome> | SmtpAuthOutcome;
}

const LOGIN_USERNAME_CHALLENGE: string = Buffer.from('Username:').toString('base64');
const LOGIN_PASSWORD_CHALLENGE: string = Buffer.from('Password:').toString('base64');

/** Raised internally when the peer disconnects mid-exchange. */
class AuthClosed extends Error {}

/** Result of the SASL exchange, resolved by the command loop into a reply. */
export type AuthExchangeResult = 'ok' | 'fail' | 'closed';

interface PerformAuthParams<S, T> {
	mechanism: string;
	/** Initial response from `AUTH <mech> <ir>`, or `null` when absent. */
	initialResponse: string | null;
	/** Mutable session view — `performAuth` sets `authenticated` / `user` on success. */
	session: MutableSmtpSession<S, T>;
	auth: SmtpAuthConfig<S, T>;
	write: (reply: SmtpReply) => void;
	/** Read one command line (without CRLF) from the peer; `null` on EOF. */
	readLine: () => Promise<string | null>;
	/** Sink for a backend `authenticate` fault (surfaced without an oracle). */
	onError?: (err: Error) => void;
}

/**
 * Drive one AUTH attempt to a verdict. Writes the `334` continuation prompts
 * itself; the FINAL `235`/`535` reply is emitted by the caller so success and
 * failure each have exactly one byte sequence. Returns `'closed'` if the peer
 * hangs up mid-exchange (the caller stops the loop without replying).
 */
export async function performAuth<S, T>(
	params: PerformAuthParams<S, T>
): Promise<AuthExchangeResult> {
	const { mechanism, initialResponse, session, auth, write, readLine, onError } = params;
	if (!auth.mechanisms.some((m) => m === mechanism)) return 'fail';

	let credentials: SmtpAuthCredentials | null;
	try {
		credentials =
			mechanism === 'PLAIN'
				? await collectPlain(initialResponse, write, readLine)
				: await collectLogin(initialResponse, write, readLine);
	} catch (err) {
		if (err instanceof AuthClosed) return 'closed';
		// Any decode/exchange fault is an indistinguishable generic failure.
		return 'fail';
	}
	if (!credentials) return 'fail';

	// A throwing/rejecting backend hook (throttle-store hiccup, transient fault)
	// must NOT escape as an unhandled rejection — that would tear the connection
	// down with no reply, a failure mode observably distinct from the generic
	// `535` (violates D6). Route it to `onError` and fail generically.
	let outcome: SmtpAuthOutcome;
	try {
		outcome = await auth.authenticate(credentials, session);
	} catch (err) {
		onError?.(err instanceof Error ? err : new Error(String(err)));
		return 'fail';
	}
	if (!outcome.ok) return 'fail';
	session.authenticated = true;
	session.user = outcome.user;
	return 'ok';
}

/** Read one continuation line, mapping EOF and client-cancel to the right signal. */
async function readContinuation(readLine: () => Promise<string | null>): Promise<string> {
	const line = await readLine();
	if (line === null) throw new AuthClosed();
	return line.trim();
}

/** Decode a base64 SASL token; a `*` cancel yields `null` (generic failure). */
function decodeToken(token: string): Buffer | null {
	if (token === '*') return null;
	return Buffer.from(token, 'base64');
}

/**
 * AUTH PLAIN: a single `authzid NUL authcid NUL passwd` token, optionally
 * supplied inline. `authcid` is the username; a null `authzid` is ignored.
 */
async function collectPlain(
	initialResponse: string | null,
	write: (reply: SmtpReply) => void,
	readLine: () => Promise<string | null>
): Promise<SmtpAuthCredentials | null> {
	let token = initialResponse;
	if (token === null) {
		write(Reply.authContinue(''));
		token = await readContinuation(readLine);
	}
	const decoded = decodeToken(token.trim());
	if (!decoded) return null;
	const firstNul = decoded.indexOf(0);
	if (firstNul === -1) return null;
	const secondNul = decoded.indexOf(0, firstNul + 1);
	if (secondNul === -1) return null;
	return {
		username: decoded.subarray(firstNul + 1, secondNul).toString('utf8'),
		password: decoded.subarray(secondNul + 1).toString('utf8'),
	};
}

/** AUTH LOGIN: base64 username then base64 password, each behind a `334` prompt. */
async function collectLogin(
	initialResponse: string | null,
	write: (reply: SmtpReply) => void,
	readLine: () => Promise<string | null>
): Promise<SmtpAuthCredentials | null> {
	let usernameToken = initialResponse;
	if (usernameToken === null) {
		write(Reply.authContinue(LOGIN_USERNAME_CHALLENGE));
		usernameToken = await readContinuation(readLine);
	}
	const usernameBuf = decodeToken(usernameToken.trim());
	if (!usernameBuf) return null;

	write(Reply.authContinue(LOGIN_PASSWORD_CHALLENGE));
	const passwordToken = await readContinuation(readLine);
	const passwordBuf = decodeToken(passwordToken);
	if (!passwordBuf) return null;

	return {
		username: usernameBuf.toString('utf8'),
		password: passwordBuf.toString('utf8'),
	};
}
