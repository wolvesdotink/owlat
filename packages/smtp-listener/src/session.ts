/**
 * Per-connection session construction and lifecycle glue.
 *
 * `session.ts` owns the boundary between a freshly-accepted `net.Socket` and the
 * pure command-loop state machine: it resolves listener options to concrete
 * defaults, builds the typed {@link SmtpSession}, runs {@link runCommandLoop},
 * and guarantees the socket is torn down exactly once when the loop returns.
 */

import type { Socket } from 'node:net';
import { runCommandLoop, type ResolvedListenerConfig } from './commandLoop.js';
import type { SmtpListenerOptions, SmtpSession } from './types.js';

const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_ABORT_FACTOR = 4;
const DEFAULT_MAX_COMMAND_BYTES = 4096;
const DEFAULT_MAX_BAD_COMMANDS = 25;
const DEFAULT_COMMAND_MS = 300_000;
const DEFAULT_DATA_MS = 600_000;

/** Apply defaults to caller options once, at listen time. */
export function resolveConfig<S, T>(opts: SmtpListenerOptions<S, T>): ResolvedListenerConfig<S, T> {
	const hostname = opts.hostname;
	return {
		hostname,
		banner: opts.banner ?? `${hostname} ESMTP`,
		extensions: opts.extensions ?? [],
		maxMessageBytes: opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
		abortFactor: opts.abortFactor ?? DEFAULT_ABORT_FACTOR,
		maxCommandBytes: opts.maxCommandBytes ?? DEFAULT_MAX_COMMAND_BYTES,
		maxBadCommands: opts.maxBadCommands ?? DEFAULT_MAX_BAD_COMMANDS,
		commandMs: opts.timeouts?.commandMs ?? DEFAULT_COMMAND_MS,
		dataMs: opts.timeouts?.dataMs ?? DEFAULT_DATA_MS,
		opts,
	};
}

let connectionCounter = 0;

/** Build the typed session object for a new connection. */
function buildSession<S, T>(
	socket: Socket,
	config: ResolvedListenerConfig<S, T>
): SmtpSession<S, T> {
	connectionCounter = (connectionCounter + 1) >>> 0;
	const base: SmtpSession<S, T> = {
		id: `${Date.now().toString(36)}-${connectionCounter.toString(36)}`,
		remoteAddress: socket.remoteAddress ?? '',
		remotePort: socket.remotePort ?? 0,
		localAddress: socket.localAddress ?? '',
		localPort: socket.localPort ?? 0,
		secure: false,
		esmtp: false,
		rcptTo: [],
		state: undefined as unknown as S,
	};
	base.state = config.opts.createSession ? config.opts.createSession(base) : (undefined as S);
	return base;
}

/**
 * Handle one accepted connection end-to-end. Any error is routed to `onError`
 * and the socket is destroyed — a connection fault never takes down the server.
 */
export function handleConnection<S, T>(socket: Socket, config: ResolvedListenerConfig<S, T>): void {
	socket.setNoDelay(true);
	// A socket-level error must not become an unhandled 'error' event crash.
	socket.on('error', (err: Error) => {
		config.opts.onError?.(err);
	});
	const session = buildSession(socket, config);
	runCommandLoop(socket, session, config)
		.catch((err: unknown) => {
			config.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
		})
		.finally(() => {
			// A clean QUIT / reject path already called socket.end(); forcing a
			// destroy there could truncate the final reply before it flushes. Only
			// tear down sockets the loop left neither ended nor destroyed.
			if (!socket.destroyed && !socket.writableEnded) socket.destroy();
		});
}
