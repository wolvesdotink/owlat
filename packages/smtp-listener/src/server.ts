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
import { createServer as createTlsServer } from 'node:tls';
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
 * Create an SMTP listener over raw `net`. `S` is per-connection session state,
 * `T` is per-transaction state (see {@link SmtpSession}).
 */
export function createSmtpListener<S = unknown, T = unknown>(
	opts: SmtpListenerOptions<S, T>
): SmtpListener {
	const config = resolveConfig<S, T>(opts);
	// Implicit TLS (port 465): the whole connection is wrapped in TLS before the
	// banner, so the accepted socket is already a handshaken `tls.TLSSocket` and
	// the session starts `secure`. Otherwise a plaintext `net` server that may
	// upgrade later via STARTTLS.
	const server: Server =
		config.implicitTls && config.tls
			? createTlsServer(config.tls.options, (socket: Socket) => {
					handleConnection(socket, config, true);
				})
			: createServer({ pauseOnConnect: false }, (socket: Socket) => {
					handleConnection(socket, config, false);
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
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
		address(): ReturnType<Server['address']> {
			return server.address();
		},
	};
}
