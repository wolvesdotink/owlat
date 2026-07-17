/**
 * The transaction layer of the in-house SMTP client.
 *
 * Sits on top of the {@link SmtpConnection} engine (which drives connect →
 * greeting → EHLO → optional STARTTLS): this file owns AUTH, the QUIT teardown,
 * the X1 RSET reuse boundary, and two convenience wrappers — {@link verify} for
 * connection testing and {@link sendMessage} for a one-shot send. The MAIL/RCPT/
 * DATA envelope itself (sequential + RFC 2920 PIPELINING) lives in `envelope.ts`;
 * this file composes it with connection setup and AUTH.
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
	serializeRset,
	serializeQuit,
	serializeAuth,
	serializeAuthContinuation,
	type EhloCapabilities,
} from './commands';
import { SmtpConnection, type SmtpConnectOptions } from './connection';
import { SmtpError, type SmtpAuthCause } from './errors';
import { isPositiveCompletion, isPositiveIntermediate, type SmtpReply } from './reply';
import { errorFromReply, sendEnvelope, type EnvelopeOptions, type SendResult } from './envelope';

export {
	type RecipientVerdict,
	type PipeliningMode,
	type EnvelopeOptions,
	type SendResult,
	sendEnvelope,
	envelopeRequiresSmtpUtf8,
} from './envelope';

// ── AUTH ────────────────────────────────────────────────────────────────────

/** The SASL mechanisms the client speaks. */
export type SmtpAuthMechanism = 'PLAIN' | 'LOGIN' | 'XOAUTH2';

/**
 * Password-based submission credentials (PLAIN / LOGIN). Serialized only over a
 * secured/loopback channel.
 */
export interface SmtpPasswordCredentials {
	username: string;
	password: string;
}

/**
 * OAuth bearer credentials (XOAUTH2). The access token is acquired and refreshed
 * by the external-accounts OAuth feature — this client only serializes it into the
 * SASL initial response; it never mints, stores, or refreshes tokens. Serialized
 * only over a secured/loopback channel, exactly like a password.
 */
export interface SmtpOAuthCredentials {
	username: string;
	accessToken: string;
}

/** Submission credentials. Serialized only over a secured/loopback channel. */
export type SmtpCredentials = SmtpPasswordCredentials | SmtpOAuthCredentials;

/** `true` when the credentials carry an OAuth bearer token (XOAUTH2). */
function isOAuthCredentials(credentials: SmtpCredentials): credentials is SmtpOAuthCredentials {
	return 'accessToken' in credentials;
}

export interface AuthenticateOptions {
	/**
	 * Preferred mechanism order. The first one the server advertises is used.
	 * Defaults to `['XOAUTH2']` for OAuth credentials and `['PLAIN', 'LOGIN']` for
	 * password credentials.
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

const DEFAULT_PASSWORD_MECHANISMS: readonly SmtpAuthMechanism[] = ['PLAIN', 'LOGIN'];
const DEFAULT_OAUTH_MECHANISMS: readonly SmtpAuthMechanism[] = ['XOAUTH2'];

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

	const oauth = isOAuthCredentials(credentials);
	const preferred =
		options.mechanisms ?? (oauth ? DEFAULT_OAUTH_MECHANISMS : DEFAULT_PASSWORD_MECHANISMS);
	const mechanism = selectMechanism(conn.capabilities, preferred);
	if (mechanism === undefined) {
		throw new SmtpError({
			phase: 'auth',
			message: 'server advertises no AUTH mechanism the client supports',
			secured: conn.secured,
		});
	}

	// The credential shape and the selected mechanism must agree: XOAUTH2 needs a
	// bearer token, PLAIN/LOGIN need a password. A mismatch is a caller error, not a
	// server verdict, so it fails closed here BEFORE anything reaches the wire rather
	// than serializing an empty/undefined secret. Using the type guard in the branch
	// condition also narrows `credentials` to the shape each helper requires.
	if (mechanism === 'XOAUTH2') {
		if (!isOAuthCredentials(credentials)) {
			throw new SmtpError({
				phase: 'auth',
				message: 'XOAUTH2 selected but no OAuth access token was supplied',
				secured: conn.secured,
			});
		}
		await authXoauth2(conn, credentials);
		return;
	}
	if (isOAuthCredentials(credentials)) {
		throw new SmtpError({
			phase: 'auth',
			message: `${mechanism} selected but only an OAuth access token was supplied`,
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

async function authPlain(
	conn: SmtpConnection,
	credentials: SmtpPasswordCredentials
): Promise<void> {
	// SASL PLAIN (RFC 4616): authzid NUL authcid NUL passwd, sent as the initial
	// response so a single round-trip completes the exchange.
	const token = base64(`\0${credentials.username}\0${credentials.password}`);
	const reply = await conn.command(serializeAuth('PLAIN', token), 'auth');
	assertAuthAccepted(reply, conn.secured);
}

async function authLogin(
	conn: SmtpConnection,
	credentials: SmtpPasswordCredentials
): Promise<void> {
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

/**
 * SASL XOAUTH2 (the Google / Microsoft bearer-token profile). The initial client
 * response is the single line
 *
 *     user=<username>^Aauth=Bearer <access-token>^A^A
 *
 * (`^A` = `\x01`), base64-encoded and sent as the AUTH initial response so a valid
 * token completes in one round-trip with a `235`.
 *
 * On rejection the server does NOT answer with a final code directly: it emits a
 * `334` challenge whose base64 body is a JSON error (`{"status":"401",…}`). The
 * client is required to answer that challenge with an empty line, after which the
 * server sends the terminal SMTP failure code. We decode the challenge to set the
 * {@link SmtpAuthCause} discriminant — `token-expired` (retry after a token
 * refresh) vs `credentials-rejected` (terminal AUTH_FAILED, re-link the account) —
 * then send the required empty continuation so the socket is left in a defined
 * state, and throw carrying both the discriminant and the server's final reply code.
 */
async function authXoauth2(conn: SmtpConnection, credentials: SmtpOAuthCredentials): Promise<void> {
	const initialResponse = base64(
		`user=${credentials.username}\x01auth=Bearer ${credentials.accessToken}\x01\x01`
	);
	const reply = await conn.command(serializeAuth('XOAUTH2', initialResponse), 'auth');
	if (reply.code === 235) {
		return;
	}
	if (isPositiveIntermediate(reply.code)) {
		// A 334 challenge: decode its JSON body to classify BEFORE we answer, then
		// send the mandatory empty continuation so the server can emit its final code.
		const authCause = classifyXoauth2Challenge(reply);
		const final = await conn.command(serializeAuthContinuation(''), 'auth');
		throw new SmtpError({
			phase: 'auth',
			message: `XOAUTH2 rejected (${authCause}) with ${final.code}`,
			replyCode: final.code,
			...(final.enhancedCode !== undefined ? { enhancedCode: final.enhancedCode } : {}),
			secured: conn.secured,
			authCause,
		});
	}
	// A server that rejected outright with a final code and no challenge — treat it
	// as a terminal auth failure classified by its reply code.
	throw new SmtpError({
		phase: 'auth',
		message: `XOAUTH2 rejected with ${reply.code}`,
		replyCode: reply.code,
		...(reply.enhancedCode !== undefined ? { enhancedCode: reply.enhancedCode } : {}),
		secured: conn.secured,
		authCause: 'credentials-rejected',
	});
}

/**
 * Decode an XOAUTH2 `334` challenge into a {@link SmtpAuthCause}. The challenge
 * text is base64(JSON); the JSON's `status` field is the HTTP-style code Google /
 * Microsoft return: `401` (unauthorized) means the bearer token was rejected and a
 * refresh may fix it (`token-expired`); anything else — `400` malformed, or a body
 * we cannot parse — is terminal (`credentials-rejected`), because re-sending the
 * same token would loop. We fail toward terminal on any ambiguity, never toward an
 * infinite refresh cycle.
 */
function classifyXoauth2Challenge(reply: SmtpReply): SmtpAuthCause {
	const status = parseXoauth2Status(reply.lines[0] ?? '');
	return status === 401 ? 'token-expired' : 'credentials-rejected';
}

/** Extract the numeric `status` from an XOAUTH2 challenge line, or `undefined`. */
function parseXoauth2Status(challenge: string): number | undefined {
	let json: string;
	try {
		json = Buffer.from(challenge.trim(), 'base64').toString('utf8');
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}
	const status = (parsed as Record<string, unknown>)['status'];
	if (typeof status === 'number') {
		return status;
	}
	if (typeof status === 'string') {
		const n = Number.parseInt(status, 10);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
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
