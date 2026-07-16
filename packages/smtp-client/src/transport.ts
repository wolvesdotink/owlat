/**
 * The raw socket layer of the connection engine: opening a plain TCP socket or
 * an implicit-TLS socket, upgrading a cleartext socket in place via STARTTLS,
 * and — critically — classifying TLS failures AT THE SOURCE.
 *
 * Every TLS/handshake failure becomes an {@link SmtpError} whose `tlsCause` is
 * derived from Node's machine-readable error code (`CERT_HAS_EXPIRED`,
 * `ERR_TLS_CERT_ALTNAME_INVALID`, `DEPTH_ZERO_SELF_SIGNED_CERT`, …) — NEVER from
 * the human-readable message. Downstream classifiers (TLS-RPT result types, the
 * outbound TLS classifier) consume that discriminant directly, so no string
 * table can drift out from under them.
 */

import net from 'node:net';
import tls from 'node:tls';

import { serializeStartTls } from './commands';
import { SmtpError, type SmtpPhase, type SmtpTlsCause } from './errors';
import { ReplyReader } from './replyReader';
import { isPositiveCompletion } from './reply';
import {
	DEFAULT_MIN_TLS_VERSION,
	type SmtpConnectOptions,
	type SmtpTimeouts,
	type SmtpTlsOptions,
} from './connectionTypes';

/**
 * Wait for a freshly-created socket to reach readiness (`connect` for a plain
 * socket, `secureConnect` for a TLS one) with a single timer / success / error
 * discipline shared by all three socket-opening paths below. On the success
 * event the timer is cleared, the error listener detached, and the socket
 * resolved; on the timeout or a wire error the socket is destroyed (so no
 * failure mode leaks an FD or leaves a half-open wrap for Node to chase) and the
 * caller's structured error is rejected.
 */
function awaitSocketReady<T extends net.Socket>(
	socket: T,
	successEvent: 'connect' | 'secureConnect',
	timeoutMs: number,
	makeTimeoutError: () => SmtpError,
	makeWireError: (err: Error) => SmtpError
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.destroy();
			reject(makeTimeoutError());
		}, timeoutMs);
		socket.once(successEvent, () => {
			clearTimeout(timer);
			socket.removeListener('error', onError);
			resolve(socket);
		});
		function onError(err: Error): void {
			clearTimeout(timer);
			socket.destroy();
			reject(makeWireError(err));
		}
		socket.once('error', onError);
	});
}

/** Open a plain TCP socket, binding `localAddress` when the caller supplied one. */
export function openPlainSocket(
	options: SmtpConnectOptions,
	timeoutMs: number
): Promise<net.Socket> {
	const connectOptions: net.TcpNetConnectOpts = { host: options.host, port: options.port };
	if (options.localAddress !== undefined) {
		connectOptions.localAddress = options.localAddress;
	}
	const socket = net.connect(connectOptions);
	return awaitSocketReady(
		socket,
		'connect',
		timeoutMs,
		() =>
			new SmtpError({
				phase: 'connect',
				message: `timed out after ${timeoutMs}ms connecting to ${options.host}:${options.port}`,
				secured: false,
			}),
		(err) =>
			new SmtpError({
				phase: 'connect',
				message: `failed to connect to ${options.host}:${options.port}: ${err.message}`,
				secured: false,
				cause: err,
			})
	);
}

/** Open an implicit-TLS socket (TLS from byte zero, e.g. submission on 465). */
export async function openTlsSocket(
	options: SmtpConnectOptions,
	tlsOptions: SmtpTlsOptions,
	servername: string,
	timeoutMs: number
): Promise<tls.TLSSocket> {
	const connectOptions = buildTlsConnectOptions(options, tlsOptions, servername);
	const socket = tls.connect(connectOptions);
	const secured = await awaitSocketReady(
		socket,
		'secureConnect',
		timeoutMs,
		() =>
			new SmtpError({
				phase: 'connect',
				message: `timed out after ${timeoutMs}ms establishing TLS to ${options.host}:${options.port}`,
				secured: false,
				tlsCause: 'handshake',
			}),
		(err) => tlsError('connect', err, false)
	);
	runPeerVerifier('connect', secured, tlsOptions.verifyPeerCertificate);
	return secured;
}

/**
 * Run the caller's post-handshake peer verifier (RFC 7672 DANE) on a freshly
 * secured socket. Runs regardless of `rejectUnauthorized` — that is the whole
 * point (DANE-EE authenticates a certificate the WebPKI path ignores). A
 * returned `Error` destroys the socket and throws a fail-closed
 * `tlsCause: 'handshake'` {@link SmtpError} so SMTP never resumes over an
 * unauthenticated channel.
 */
function runPeerVerifier(
	phase: SmtpPhase,
	socket: tls.TLSSocket,
	verify: ((socket: tls.TLSSocket) => Error | undefined) | undefined
): void {
	if (verify === undefined) {
		return;
	}
	const err = verify(socket);
	if (err !== undefined) {
		socket.destroy();
		throw new SmtpError({
			phase,
			message: `peer certificate verification failed: ${err.message}`,
			secured: false,
			tlsCause: 'handshake',
			cause: err,
		});
	}
}

/**
 * The security-relevant TLS knobs, shared by the implicit-TLS connect and the
 * STARTTLS upgrade so a future option cannot be wired into one path and
 * forgotten on the other.
 */
type TlsSecurityOptions = Pick<
	tls.ConnectionOptions,
	'servername' | 'minVersion' | 'rejectUnauthorized' | 'ca' | 'checkServerIdentity'
>;

/** `tls.connect` forwards net options at runtime; `localAddress` is one of them. */
type TlsConnectOptions = tls.ConnectionOptions & Pick<net.TcpNetConnectOpts, 'localAddress'>;

/**
 * Assemble the shared TLS security options — SNI servername, the TLSv1.2 floor
 * default, the fail-closed `rejectUnauthorized` default, and the pinned/DANE
 * passthroughs (`ca`, `checkServerIdentity`). Both TLS entry points build on
 * this so the security posture is defined in exactly one place.
 */
function buildTlsSecurityOptions(
	tlsOptions: SmtpTlsOptions,
	servername: string
): TlsSecurityOptions {
	const secure: TlsSecurityOptions = {
		servername,
		minVersion: tlsOptions.minVersion ?? DEFAULT_MIN_TLS_VERSION,
		rejectUnauthorized: tlsOptions.rejectUnauthorized ?? true,
	};
	if (tlsOptions.ca !== undefined) {
		secure.ca = tlsOptions.ca;
	}
	if (tlsOptions.checkServerIdentity !== undefined) {
		secure.checkServerIdentity = tlsOptions.checkServerIdentity;
	}
	return secure;
}

function buildTlsConnectOptions(
	options: SmtpConnectOptions,
	tlsOptions: SmtpTlsOptions,
	servername: string
): TlsConnectOptions {
	const connectOptions: TlsConnectOptions = {
		host: options.host,
		port: options.port,
		...buildTlsSecurityOptions(tlsOptions, servername),
	};
	if (options.localAddress !== undefined) {
		connectOptions.localAddress = options.localAddress;
	}
	return connectOptions;
}

/**
 * Issue STARTTLS on an already-open cleartext socket, wait for the 220, then
 * wrap the socket in TLS in place. The {@link ReplyReader} is paused before the
 * wrap (post-220 bytes are TLS records, not SMTP lines) and rebound to the
 * secured socket on success. A refused STARTTLS is `starttls-unavailable`.
 *
 * RFC 3207 §4.2 / CVE-2011-0411: after the 220 and before the wrap, any bytes
 * the peer (or a MITM who let STARTTLS through) appended in cleartext are
 * discarded knowledge — we fail closed if the reader is holding ANY buffered
 * reply data, and the secured leg reads through a FRESH parser so no pre-TLS
 * byte can ever be decoded as a post-TLS reply.
 */
export async function startTlsUpgrade(
	reader: ReplyReader,
	socket: net.Socket,
	tlsOptions: SmtpTlsOptions,
	servername: string,
	timeouts: SmtpTimeouts
): Promise<tls.TLSSocket> {
	socket.write(serializeStartTls());
	const reply = await reader.read('starttls', timeouts.command, false);
	if (!isPositiveCompletion(reply.code)) {
		throw new SmtpError({
			phase: 'starttls',
			message: `server refused STARTTLS with ${reply.code}: ${reply.text}`,
			secured: false,
			replyCode: reply.code,
			tlsCause: 'starttls-unavailable',
		});
	}
	// Fail closed on plaintext injection: nothing may sit in the reader between
	// the 220 and the TLS wrap. A queued reply or a partial line here is a peer
	// that appended cleartext bytes after the 220 — the classic STARTTLS command
	// injection — which must never survive into the secured session.
	if (reader.hasBufferedData) {
		throw new SmtpError({
			phase: 'starttls',
			message: 'peer sent data after the STARTTLS 220 (plaintext-injection); refusing to upgrade',
			secured: false,
		});
	}
	// Detach the cleartext reader before wrapping the socket; any bytes the
	// server sends after this point are TLS records, not SMTP lines.
	reader.pauseSource();
	const upgradeOptions: tls.ConnectionOptions = {
		socket,
		...buildTlsSecurityOptions(tlsOptions, servername),
	};
	const secureSocket = await awaitSocketReady(
		tls.connect(upgradeOptions),
		'secureConnect',
		timeouts.connect,
		() =>
			new SmtpError({
				phase: 'starttls',
				message: `timed out after ${timeouts.connect}ms during STARTTLS handshake`,
				secured: false,
				tlsCause: 'handshake',
			}),
		(err) => tlsError('starttls', err, false)
	);
	// Authenticate the peer certificate (RFC 7672 DANE) on the secured socket
	// BEFORE any post-TLS byte is read. Runs even under `rejectUnauthorized:false`
	// (DANE-EE), and fails closed on a mismatch — SMTP never resumes over an
	// unauthenticated channel.
	runPeerVerifier('starttls', secureSocket, tlsOptions.verifyPeerCertificate);
	// Safe to rebind AFTER the await: the secured socket does not flow until a
	// `data` listener attaches, so no post-handshake byte is lost in the gap.
	// Start the secured leg on a fresh parser (RFC 3207 §4.2): discard all
	// pre-TLS parser state before reading a single post-TLS byte.
	reader.resetParser();
	reader.rebind(secureSocket);
	return secureSocket;
}

// ── TLS error classification (FROM NODE ERROR CODES, never strings) ──────────

interface NodeErrorLike {
	code?: string;
}

/**
 * Map a Node TLS/handshake error onto a structured {@link SmtpError}. The
 * `tlsCause` is derived from `err.code` — the machine-readable OpenSSL/Node
 * verification code — NEVER from the human message. Verification failures the
 * spec cares about each get their exact cause; anything else is `handshake`.
 */
function tlsError(phase: SmtpPhase, err: Error, secured: boolean): SmtpError {
	const code = (err as NodeErrorLike).code;
	const tlsCause = classifyTlsErrorCode(code);
	return new SmtpError({
		phase,
		message: `TLS handshake failed (${code ?? 'unknown'}): ${err.message}`,
		secured,
		tlsCause,
		cause: err,
	});
}

function classifyTlsErrorCode(code: string | undefined): SmtpTlsCause {
	switch (code) {
		case 'CERT_HAS_EXPIRED':
			return 'cert-expired';
		case 'ERR_TLS_CERT_ALTNAME_INVALID':
			return 'cert-host-mismatch';
		case 'DEPTH_ZERO_SELF_SIGNED_CERT':
		case 'SELF_SIGNED_CERT_IN_CHAIN':
		case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
		case 'UNABLE_TO_GET_ISSUER_CERT':
		case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
		case 'CERT_UNTRUSTED':
			return 'cert-untrusted';
		default:
			return 'handshake';
	}
}
