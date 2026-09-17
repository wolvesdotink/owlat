/**
 * The public listener factory.
 *
 * `createSmtpListener` wraps a raw `net.Server`: every accepted connection runs
 * the L1 command loop with the caller's handlers. There is NO TLS and NO AUTH
 * here — L2 wraps this to add STARTTLS/implicit-TLS and SASL. The returned
 * handle mirrors the surface the bounce/submission servers need (`listen`,
 * `close`, `address`) so the eventual cutover is mechanical.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer, type TLSSocket, type TlsOptions } from 'node:tls';
import { handleConnection, resolveConfig } from './session.js';
import type { SmtpListenerOptions } from './types.js';

/** A running (or listenable) SMTP listener. */
export interface SmtpListener {
	/** Begin accepting connections. Resolves once the socket is bound. */
	listen(port: number, host?: string): Promise<void>;
	/** Stop accepting and wait for the server socket to close. */
	close(): Promise<void>;
	/** The bound address (`null` before `listen`). */
	address(): ReturnType<Server['address']>;
	/** Escape hatch to the underlying `net.Server` (event wiring, tests). */
	readonly raw: Server;
}

/**
 * The implicit-TLS (465) server, with the teardown node does NOT do for us.
 *
 * A failed handshake reaches `'tlsClientError'`, and node's own cleanup is
 * SPLIT across that event — measured on node 22.20.0:
 *
 *  - A bogus record (`ERR_SSL_PACKET_LENGTH_TOO_LONG`, i.e. a peer speaking
 *    plaintext SMTP at a 465 listener) and a genuine negotiation failure
 *    (`ERR_SSL_NO_SHARED_CIPHER`) both arrive with the socket ALREADY
 *    destroyed. OpenSSL has written its alert and node has torn the connection
 *    down; there is nothing left to do and nothing left to truncate.
 *  - A handshake that simply never progresses (`ERR_TLS_HANDSHAKE_TIMEOUT`)
 *    arrives with the socket STILL OPEN, and node never closes it. The peer
 *    holds the FD for as long as it likes. That socket never reached `accept`,
 *    so it is in neither the command loop's idle timers nor `close()`'s
 *    teardown set — nothing else in this package can reach it.
 *
 * The asymmetry is in node's own source, not in the OS, so it is the same on
 * every platform we ship to: `TLSSocket.prototype._handleTimeout` is
 * `this._emitTLSError(new ERR_TLS_HANDSHAKE_TIMEOUT())` and nothing else, and
 * the `'_tlsError'` handler behind `tlsClientError` only re-emits. The window
 * itself is `options.handshakeTimeout || 120 * 1000`.
 *
 * So: destroy what is still open. The guard is not a micro-optimization, it is
 * the whole discriminator — it fires only on the connections node abandoned,
 * and it cannot cut short an alert that a real client is mid-way through
 * reading, because those sockets are already destroyed when we see them.
 *
 * `onError` is reported on exactly the same condition, for two reasons. It is
 * the only case where this listener CHANGED the outcome, so it is the only one
 * an operator cannot infer from the peer's own behavior; and it is the only one
 * that cannot be used as a log-volume amplifier. Both silent paths are free for
 * an attacker to trigger in a tight loop, while a timeout costs a held
 * connection for the whole `handshakeTimeout` — a peer wanting N lines per
 * second must park N × timeout connections, which the OS bounds long before the
 * log does.
 */
function createImplicitTlsServer(
	options: TlsOptions,
	accept: (socket: Socket, initialSecure: boolean) => void,
	onError: ((err: Error) => void) | undefined
): Server {
	const server = createTlsServer(options, (socket: Socket) => {
		accept(socket, true);
	});
	server.on('tlsClientError', (err: Error, socket: TLSSocket) => {
		if (socket.destroyed) return;
		onError?.(err);
		socket.destroy();
	});
	return server;
}

/**
 * Create an SMTP listener over raw `net`. `S` is per-connection session state,
 * `T` is per-transaction state (see {@link SmtpSession}).
 */
export function createSmtpListener<S = unknown, T = unknown>(
	opts: SmtpListenerOptions<S, T>
): SmtpListener {
	const config = resolveConfig<S, T>(opts);
	// Track live connections so `close()` can tear them down deterministically
	// instead of blocking on in-flight sessions (a stalled peer must not hold the
	// listener — or a test's `afterEach` — open indefinitely).
	const sockets = new Set<Socket>();
	const accept = (socket: Socket, initialSecure: boolean): void => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
		handleConnection(socket, config, initialSecure);
	};
	// Implicit TLS (port 465): the whole connection is wrapped in TLS before the
	// banner, so the accepted socket is already a handshaken `tls.TLSSocket` and
	// the session starts `secure`. Otherwise a plaintext `net` server that may
	// upgrade later via STARTTLS.
	const server: Server =
		config.implicitTls && config.tls
			? createImplicitTlsServer(config.tls.options, accept, opts.onError)
			: createServer({ pauseOnConnect: false }, (socket: Socket) => {
					accept(socket, false);
				});
	server.on('error', (err: Error) => {
		opts.onError?.(err);
	});

	return {
		raw: server,
		listen(port: number, host?: string): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				const onError = (err: Error): void => reject(err);
				server.once('error', onError);
				server.listen(port, host, () => {
					server.removeListener('error', onError);
					resolve();
				});
			});
		},
		close(): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				// Destroy live connections first so `server.close` (which waits for
				// open sockets) resolves promptly rather than hanging on a peer that
				// never QUITs.
				for (const socket of sockets) socket.destroy();
				sockets.clear();
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
		address(): ReturnType<Server['address']> {
			return server.address();
		},
	};
}
