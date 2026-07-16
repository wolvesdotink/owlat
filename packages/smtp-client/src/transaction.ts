/**
 * The transaction layer of the in-house SMTP client.
 *
 * Sits on top of the {@link SmtpConnection} engine (which drives connect →
 * greeting → EHLO → optional STARTTLS): this file owns AUTH, the MAIL/RCPT/DATA
 * envelope, the QUIT teardown, and two convenience wrappers — {@link verify} for
 * connection testing and {@link sendMessage} for a one-shot send.
 *
 * Every failure is a phase-tagged {@link SmtpError}: the retry taxonomy the MTA
 * builds (AMBIGUOUS_TIMEOUT never auto-retried in phase `data`/`data-final`,
 * everything earlier safely retryable) reads `.phase`/`.replyCode`/`.tlsCause` —
 * NEVER a log string. Two invariants are enforced structurally, not by policy:
 *
 *  - AUTH is refused BEFORE credentials are serialized unless the socket is
 *    `secured` or the peer is loopback (the mail-sync submission invariant, W4).
 *  - RCPT collects a per-recipient verdict; the transaction proceeds as long as
 *    at least one recipient was accepted, reporting the rest with their codes.
 */

import {
	serializeMailFrom,
	serializeRcptTo,
	serializeData,
	serializeQuit,
	serializeAuth,
	serializeAuthContinuation,
	hasCapability,
	type EhloCapabilities,
} from './commands';
import { SmtpConnection, type SmtpConnectOptions } from './connection';
import { SmtpError, type SmtpErrorInit, type SmtpPhase } from './errors';
import { dotStuffMessage } from './dotStuff';
import { isPositiveCompletion, isPositiveIntermediate, type SmtpReply } from './reply';

// ── AUTH ────────────────────────────────────────────────────────────────────

/** The SASL mechanisms the client speaks. XOAUTH2 is a later capability (X4). */
export type SmtpAuthMechanism = 'PLAIN' | 'LOGIN';

/** Submission credentials. Serialized only over a secured/loopback channel. */
export interface SmtpCredentials {
	username: string;
	password: string;
}

export interface AuthenticateOptions {
	/**
	 * Preferred mechanism order. The first one the server advertises is used.
	 * Defaults to `['PLAIN', 'LOGIN']`.
	 */
	mechanisms?: readonly SmtpAuthMechanism[];
	/**
	 * Whether the peer is a trusted loopback relay, letting AUTH proceed over a
	 * cleartext channel (the mail-sync submission-to-localhost path). This flag
	 * can only STRENGTHEN the rule, never widen it: loopback is always derived
	 * from the socket's remote address, so a genuinely remote cleartext peer is
	 * refused regardless of what the caller passes. Passing `false` forces the
	 * strict "secured only" rule even on a loopback peer; passing `true` (or
	 * omitting it) still requires the address to actually be loopback — it cannot
	 * assert loopback for a remote peer.
	 */
	loopback?: boolean;
}

const DEFAULT_AUTH_MECHANISMS: readonly SmtpAuthMechanism[] = ['PLAIN', 'LOGIN'];

/**
 * RFC 5321 §4.1.1.1 loopback literals, incl. the whole IPv4-mapped-IPv6 form.
 * Mirrors mail-sync's `isLoopbackHost`, which accepts all of `127.x.x.x` and its
 * `::ffff:127.x.x.x` mapping — the invariant this client encodes.
 */
function isLoopbackAddress(address: string | undefined): boolean {
	if (address === undefined) {
		return false;
	}
	return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

function base64(value: string): string {
	return Buffer.from(value, 'utf8').toString('base64');
}

/**
 * Authenticate an already-open connection. Refuses BEFORE any credential bytes
 * are serialized when the channel is neither `secured` nor loopback — the client
 * itself carries the invariant, so no call site can leak credentials in cleartext
 * to a remote server.
 */
export async function authenticate(
	conn: SmtpConnection,
	credentials: SmtpCredentials,
	options: AuthenticateOptions = {}
): Promise<void> {
	// The flag can only STRENGTHEN: `loopback: false` forces the strict rule, but a
	// truthy/absent flag still requires the address itself to be loopback. A call
	// site can never assert loopback for a remote peer and leak credentials in
	// cleartext — the address is always the ground truth.
	const loopback = options.loopback === false ? false : isLoopbackAddress(conn.remoteAddress);
	if (!conn.secured && !loopback) {
		// Fail closed BEFORE serialization: never put credentials on the wire in
		// cleartext to a non-loopback peer.
		throw new SmtpError({
			phase: 'auth',
			message: 'refusing AUTH on an unsecured, non-loopback connection',
			secured: conn.secured,
		});
	}

	const mechanism = selectMechanism(
		conn.capabilities,
		options.mechanisms ?? DEFAULT_AUTH_MECHANISMS
	);
	if (mechanism === undefined) {
		throw new SmtpError({
			phase: 'auth',
			message: 'server advertises no AUTH mechanism the client supports',
			secured: conn.secured,
		});
	}

	if (mechanism === 'PLAIN') {
		await authPlain(conn, credentials);
	} else {
		await authLogin(conn, credentials);
	}
}

function selectMechanism(
	caps: EhloCapabilities,
	preferred: readonly SmtpAuthMechanism[]
): SmtpAuthMechanism | undefined {
	for (const mech of preferred) {
		if (caps.authMechanisms.has(mech)) {
			return mech;
		}
	}
	return undefined;
}

async function authPlain(conn: SmtpConnection, credentials: SmtpCredentials): Promise<void> {
	// SASL PLAIN (RFC 4616): authzid NUL authcid NUL passwd, sent as the initial
	// response so a single round-trip completes the exchange.
	const token = base64(`\0${credentials.username}\0${credentials.password}`);
	const reply = await conn.command(serializeAuth('PLAIN', token), 'auth');
	assertAuthAccepted(reply, conn.secured);
}

async function authLogin(conn: SmtpConnection, credentials: SmtpCredentials): Promise<void> {
	// SASL LOGIN: server challenges for the username, then the password, each as a
	// base64 continuation. We do not depend on the challenge text (servers vary);
	// a 334 means "send the next field".
	const start = await conn.command(serializeAuth('LOGIN'), 'auth');
	assertContinuation(start, conn.secured);
	const userReply = await conn.command(
		serializeAuthContinuation(base64(credentials.username)),
		'auth'
	);
	assertContinuation(userReply, conn.secured);
	const passReply = await conn.command(
		serializeAuthContinuation(base64(credentials.password)),
		'auth'
	);
	assertAuthAccepted(passReply, conn.secured);
}

function assertContinuation(reply: SmtpReply, secured: boolean): void {
	if (isPositiveIntermediate(reply.code)) {
		return;
	}
	throw errorFromReply('auth', `AUTH rejected with ${reply.code}`, secured, reply);
}

function assertAuthAccepted(reply: SmtpReply, secured: boolean): void {
	// 235 is the only success (RFC 4954). Anything else — 535 bad creds, a stray
	// 334, a 5xx — is an auth failure.
	if (reply.code === 235) {
		return;
	}
	throw errorFromReply('auth', `AUTH rejected with ${reply.code}`, secured, reply);
}

/**
 * The single constructor for a phase-tagged {@link SmtpError} carrying a server
 * reply's code. Pass the `reply` (or a `{ code, enhancedCode }` view of a
 * per-recipient verdict) to copy its `replyCode`/`enhancedCode`; omit it for a
 * client-side refusal that carries no reply code.
 */
function errorFromReply(
	phase: SmtpPhase,
	message: string,
	secured: boolean,
	reply?: { code: number; enhancedCode?: string }
): SmtpError {
	const init: SmtpErrorInit = { phase, message, secured };
	if (reply !== undefined) {
		init.replyCode = reply.code;
		if (reply.enhancedCode !== undefined) {
			init.enhancedCode = reply.enhancedCode;
		}
	}
	return new SmtpError(init);
}

// ── Envelope + DATA ───────────────────────────────────────────────────────────

/** The verdict the server returned for a single recipient's RCPT TO. */
export interface RecipientVerdict {
	/** The recipient mailbox exactly as offered in RCPT TO. */
	recipient: string;
	/** `true` iff the server returned a 2xx completion for this recipient. */
	accepted: boolean;
	/** The three-digit reply code the server returned. */
	replyCode: number;
	/** RFC 3463 enhanced status code, when the server supplied one. */
	enhancedCode?: string;
	/** The reply text (for logs — never classified against). */
	message: string;
}

export interface EnvelopeOptions {
	/** Return-path mailbox. The empty string serializes the null sender `<>`. */
	from: string;
	/** Recipient mailboxes. At least one must be accepted for DATA to run. */
	to: readonly string[];
	/** The composed message bytes (already RFC 5322; dot-stuffed on the wire). */
	data: Buffer | string;
	/** Extra ESMTP params on MAIL FROM, appended after an auto SIZE. */
	mailParams?: readonly string[];
	/** Extra ESMTP params on every RCPT TO (e.g. `NOTIFY=NEVER`). */
	rcptParams?: readonly string[];
}

/** The outcome of a completed DATA transaction. */
export interface SendResult {
	/** Recipients the server accepted (RCPT 2xx). Never empty on success. */
	accepted: RecipientVerdict[];
	/** Recipients the server rejected, with their reply codes. */
	rejected: RecipientVerdict[];
	/** The final reply that acknowledged the message (2xx). */
	response: SmtpReply;
}

/**
 * Run a MAIL/RCPT/DATA transaction on an open, authenticated (if needed)
 * connection. Collects a per-recipient RCPT verdict and proceeds to DATA as long
 * as ≥1 recipient was accepted; if none were, throws in phase `rcpt` (safely
 * retryable). A drop during or after the body surfaces in phase `data`/
 * `data-final` — the ambiguous, never-auto-retried region.
 */
export async function sendEnvelope(
	conn: SmtpConnection,
	options: EnvelopeOptions
): Promise<SendResult> {
	if (options.to.length === 0) {
		// Nothing to deliver to — refuse BEFORE MAIL FROM reaches the wire. A
		// client-side refusal, so no reply code; phase `rcpt` keeps it in the safely
		// retryable region.
		throw errorFromReply('rcpt', 'no recipients supplied', conn.secured);
	}

	const body = typeof options.data === 'string' ? Buffer.from(options.data, 'utf8') : options.data;

	// MAIL FROM, with SIZE when the server advertised it (RFC 1870). The declared
	// size is the un-stuffed message length — what the server budgets against.
	const mailParams: string[] = [];
	if (hasCapability(conn.capabilities, 'SIZE')) {
		mailParams.push(`SIZE=${body.length}`);
	}
	if (options.mailParams !== undefined) {
		mailParams.push(...options.mailParams);
	}
	const mailReply = await conn.command(serializeMailFrom(options.from, mailParams), 'mail');
	assertCompletion(mailReply, 'mail', conn.secured);

	// RCPT TO — one per recipient, collecting verdicts.
	const rcptParams = options.rcptParams ?? [];
	const accepted: RecipientVerdict[] = [];
	const rejected: RecipientVerdict[] = [];
	for (const recipient of options.to) {
		const reply = await conn.command(serializeRcptTo(recipient, rcptParams), 'rcpt');
		const verdict = toVerdict(recipient, reply);
		if (verdict.accepted) {
			accepted.push(verdict);
		} else {
			rejected.push(verdict);
		}
	}
	if (accepted.length === 0) {
		// Every recipient was refused — there is nothing to deliver. Report in phase
		// `rcpt` (pre-DATA, so safely retryable) carrying the last rejection's code.
		const last = rejected[rejected.length - 1];
		throw errorFromReply(
			'rcpt',
			'every recipient was rejected',
			conn.secured,
			last === undefined ? undefined : { code: last.replyCode, enhancedCode: last.enhancedCode }
		);
	}

	// DATA — the 354 intermediate handshake (phase `data`).
	const dataReply = await conn.command(serializeData(), 'data');
	if (!isPositiveIntermediate(dataReply.code)) {
		throw errorFromReply(
			'data',
			`server rejected data with ${dataReply.code}`,
			conn.secured,
			dataReply
		);
	}

	// Stream the dot-stuffed body + terminator, then await the final reply. Both
	// the write and the wait live in phase `data-final`: a drop here is the
	// double-delivery-ambiguous region the retry taxonomy must never auto-retry.
	// The socket-lifecycle mechanics live on SmtpConnection, which owns the socket.
	await conn.writePayload(dotStuffMessage(body), 'data-final');
	const finalReply = await conn.readReply('data-final', conn.dataTimeoutMs);
	assertCompletion(finalReply, 'data-final', conn.secured);

	return { accepted, rejected, response: finalReply };
}

function toVerdict(recipient: string, reply: SmtpReply): RecipientVerdict {
	const verdict: RecipientVerdict = {
		recipient,
		accepted: isPositiveCompletion(reply.code),
		replyCode: reply.code,
		message: reply.text,
	};
	if (reply.enhancedCode !== undefined) {
		verdict.enhancedCode = reply.enhancedCode;
	}
	return verdict;
}

function assertCompletion(reply: SmtpReply, phase: 'mail' | 'data-final', secured: boolean): void {
	if (isPositiveCompletion(reply.code)) {
		return;
	}
	throw errorFromReply(phase, `server rejected ${phase} with ${reply.code}`, secured, reply);
}

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
}

/**
 * One-shot convenience: connect → (AUTH) → MAIL/RCPT/DATA → QUIT, tearing the
 * connection down on every exit. Preserves the one-connection-per-send semantics
 * of the migration (W3) — RSET socket reuse is a later capability (X1).
 */
export async function sendMessage(options: SendMessageOptions): Promise<SendResult> {
	const conn = await SmtpConnection.connect(options.connect);
	try {
		if (options.auth !== undefined) {
			await authenticate(conn, options.auth.credentials, authOptions(options.auth));
		}
		const result = await sendEnvelope(conn, options.envelope);
		await quit(conn);
		return result;
	} catch (err) {
		conn.close();
		throw err;
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
