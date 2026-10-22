/**
 * TLS server bootstrap. Per-IP connection caps and a global cap, both taken
 * at TCP accept so a pending TLS handshake holds a slot; SNI callback wired so
 * multi-domain certs (mail.<customer-domain>) can be added later without code
 * changes.
 */

import { createServer as createPlainServer, type Server as TlsServer, type TlsOptions } from 'tls';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'net';
import { ipRateLimitKey, unmapIpv4 } from '@owlat/shared/ipAddress';
import { HARDENED_SERVER_TLS_OPTIONS } from '@owlat/shared/tlsPolicy';
import type { ImapConfig } from './config.js';
import type { ConvexClient } from './convex.js';
import { ImapConnection } from './connection.js';
import type { AuthRateLimiter } from './rateLimit.js';
import { logger } from './logger.js';
import { startImapTlsReload } from './tlsReload.js';
import { installShutdown, pinoShutdownLog, type ShutdownHandle } from '@owlat/shared/nodeShutdown';

/** The IMAPS cipher policy, shared with the SMTP listeners. */
const TLS_POLICY: TlsOptions = HARDENED_SERVER_TLS_OPTIONS;

/**
 * Hard-exit deadline for a shutdown, under the compose stop_grace_period of
 * 30s so the watchdog, not Docker's SIGKILL, ends a wedged drain.
 */
const SHUTDOWN_TIMEOUT_MS = 25_000;

/**
 * Time an IMAPS peer has, from TCP accept, to finish the TLS handshake. The
 * same 30 s the SMTP implicit-TLS listener allows (see `submissionTls` in the
 * MTA for the reasoning): room for a lossy mobile link to retransmit its
 * ClientHello, well under node's own 120 s handshake timeout, which only
 * restarts on activity and so never bounds a peer that trickles bytes.
 */
const TLS_HANDSHAKE_TIMEOUT_MS = 30_000;

interface ConnectionAccounting {
	totalActive: number;
	perIp: Map<string, number>;
}

export interface ImapServerHandle {
	server: TcpServer | TlsServer;
	stopTlsReload: () => void;
	/** Send `* BYE <reason>` to every open connection and close it. */
	closeAllConnections: (reason: string) => void;
}

export function startImapServer(
	config: ImapConfig,
	convex: ConvexClient,
	rateLimiter: AuthRateLimiter
): ImapServerHandle {
	const accounting: ConnectionAccounting = {
		totalActive: 0,
		perIp: new Map(),
	};
	// Every accepted session, so a shutdown can say BYE to each one. The
	// listener's close() waits for all of them, and an IDLE client never hangs
	// up on its own.
	const connections = new Set<ImapConnection>();
	// IMAPS sockets still in their TLS handshake, keyed by connection 4-tuple.
	// They hold a slot but have no session yet, so the shutdown destroys them.
	const handshakes = new Map<string, { socket: Socket; deadline: NodeJS.Timeout }>();
	const closeAllConnections = (reason: string) => {
		for (const connection of connections) connection.shutdown(reason);
		for (const { socket } of handshakes.values()) socket.destroy();
	};

	/**
	 * Count `socket` against the per-IP and global caps, or name the cap it
	 * would break. The slot is released once, when the socket closes.
	 */
	const reserveSlot = (socket: Socket): 'per-ip' | 'global' | null => {
		// A dual-stack listener reports IPv4 peers as `::ffff:a.b.c.d`; unmap so
		// one host is counted under one key whichever family it arrived on.
		// The per-IP cap counts an IPv6 peer by its /64, as the LOGIN limiter
		// does: one host can take a fresh address from its /64 per connection.
		const slotKey = ipRateLimitKey(unmapIpv4(socket.remoteAddress ?? 'unknown'));
		const perIp = (accounting.perIp.get(slotKey) ?? 0) + 1;
		if (perIp > config.maxConnectionsPerIp) return 'per-ip';
		if (accounting.totalActive >= config.maxClients) return 'global';
		accounting.perIp.set(slotKey, perIp);
		accounting.totalActive += 1;
		socket.once('close', () => {
			accounting.totalActive = Math.max(0, accounting.totalActive - 1);
			const remaining = (accounting.perIp.get(slotKey) ?? 1) - 1;
			if (remaining <= 0) accounting.perIp.delete(slotKey);
			else accounting.perIp.set(slotKey, remaining);
		});
		return null;
	};

	const startSession = (socket: Socket, tls: boolean) => {
		const ip = unmapIpv4(socket.remoteAddress ?? 'unknown');
		const connection = new ImapConnection(socket, config, convex, rateLimiter, ip, tls);
		connections.add(connection);
		socket.on('close', () => connections.delete(connection));
	};

	if (config.tls) {
		const server = createPlainServer(
			{ ...TLS_POLICY, cert: config.tls.cert, key: config.tls.key },
			(socket: Socket) => {
				const handshake = handshakes.get(connectionKey(socket));
				if (handshake) {
					clearTimeout(handshake.deadline);
					handshakes.delete(connectionKey(socket));
				}
				startSession(socket, true);
			}
		);
		admitBeforeHandshake(
			server,
			reserveSlot,
			handshakes,
			config.tlsHandshakeTimeoutMs ?? TLS_HANDSHAKE_TIMEOUT_MS
		);
		// A renewed certificate on the mail-certs volume is swapped in place.
		const reloader = startImapTlsReload(server, config.tls, TLS_POLICY);
		server.listen(config.port, config.listenAddress, () => {
			logger.info({ port: config.port, listen: config.listenAddress }, 'IMAPS listening (TLS)');
		});
		server.on('error', (err) => logger.error({ err }, 'TLS server error'));
		return { server, stopTlsReload: () => reloader?.stop(), closeAllConnections };
	}

	// Dev fallback — bind a plain TCP server. NOT for production.
	if (config.production) {
		throw new Error(
			'IMAP refusing to start in production without TLS cert/key. ' +
				'Set IMAP_TLS_CERT/IMAP_TLS_KEY or mount certs at /opt/owlat/certs.'
		);
	}
	logger.warn('TLS cert/key not configured — starting in plaintext mode (dev only)');
	const server = createTcpServer((socket) => {
		const refusal = reserveSlot(socket);
		if (refusal) {
			socket.write(
				refusal === 'per-ip'
					? '* BYE Too many connections from this IP\r\n'
					: '* BYE Server connection limit reached\r\n'
			);
			socket.end();
			return;
		}
		startSession(socket, false);
	});
	server.listen(config.port, config.listenAddress, () => {
		logger.info(
			{ port: config.port, listen: config.listenAddress },
			'IMAP listening (plain — dev only)'
		);
	});
	server.on('error', (err) => logger.error({ err }, 'TCP server error'));
	return { server, stopTlsReload: () => {}, closeAllConnections };
}

/**
 * Identifies one live connection on both the accepted TCP socket and the
 * `TLSSocket` node wraps around it, which report the same addresses.
 */
function connectionKey(socket: Socket): string {
	return `${socket.remoteAddress}|${socket.remotePort}|${socket.localAddress}|${socket.localPort}`;
}

/**
 * Admit IMAPS peers at TCP accept, before any TLS work.
 *
 * `tls.Server` wraps every accepted socket in its own `connection` listener and
 * only emits `secureConnection` once the handshake is done. Counting there let
 * a peer that never negotiates hold a connection outside both caps and outside
 * the session's idle and pre-auth timers. So node's listener is detached and
 * replayed only for sockets that win a slot; the rest are destroyed, since no
 * IMAP reply can be sent before TLS. Each admitted socket gets a fixed
 * handshake deadline, cleared when its session starts. The slot itself is
 * released by the TCP socket's `close`, which fires for every outcome:
 * refused handshake, timeout, peer hang-up, or the end of a full session.
 */
function admitBeforeHandshake(
	server: TlsServer,
	reserveSlot: (socket: Socket) => string | null,
	handshakes: Map<string, { socket: Socket; deadline: NodeJS.Timeout }>,
	timeoutMs: number
): void {
	const tlsAccept = server.listeners('connection') as Array<(socket: Socket) => void>;
	server.removeAllListeners('connection');
	server.on('connection', (socket: Socket) => {
		if (reserveSlot(socket)) {
			socket.destroy();
			return;
		}
		const key = connectionKey(socket);
		const deadline = setTimeout(() => socket.destroy(), timeoutMs);
		handshakes.set(key, { socket, deadline });
		socket.once('close', () => {
			clearTimeout(deadline);
			if (handshakes.get(key)?.socket === socket) handshakes.delete(key);
		});
		for (const accept of tlsAccept) accept.call(server, socket);
	});
	// Node reports a failed handshake here and, for its own handshake timeout,
	// leaves the socket open. Close it so the slot frees.
	server.on('tlsClientError', (_err: Error, socket: Socket) => {
		if (!socket.destroyed) socket.destroy();
	});
}

export interface ImapShutdownOptions {
	/** Runs last, after every connection has closed (the Redis client). */
	disconnect?: () => void;
	/** Seams for tests; default to `process.exit` and SIGTERM + SIGINT. */
	exit?: (code: number) => void;
	signals?: NodeJS.Signals[];
}

/**
 * Stop the listener, BYE every session, then release the rest, bounded by
 * {@link SHUTDOWN_TIMEOUT_MS}; a clean drain exits 0.
 *
 * `installShutdown` waits for `close()`'s callback before it drains, and that
 * callback only fires once every socket has ended. So the BYEs go out from the
 * adapter's `closeIdleConnections`, which it calls right after `close()`;
 * sending them from `drain` would wait on `close()` until the watchdog fired.
 */
export function installImapShutdown(
	imap: ImapServerHandle,
	options: ImapShutdownOptions = {}
): ShutdownHandle {
	const { server, stopTlsReload, closeAllConnections } = imap;
	return installShutdown({
		server: {
			close: (callback) => server.close(callback),
			closeIdleConnections: () => closeAllConnections('Server shutting down'),
		},
		drain: async () => {
			stopTlsReload();
			options.disconnect?.();
		},
		timeoutMs: SHUTDOWN_TIMEOUT_MS,
		log: pinoShutdownLog(logger),
		...(options.exit ? { exit: options.exit } : {}),
		...(options.signals ? { signals: options.signals } : {}),
	});
}
