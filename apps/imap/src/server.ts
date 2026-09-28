/**
 * TLS server bootstrap. Per-IP connection caps and a global cap;
 * SNI callback wired so multi-domain certs (mail.<customer-domain>)
 * can be added later without code changes.
 */

import { createServer as createPlainServer, type Server as TlsServer, type TlsOptions } from 'tls';
import { createServer as createTcpServer, type Server as TcpServer } from 'net';
import { unmapIpv4 } from '@owlat/shared/ipAddress';
import { HARDENED_SERVER_TLS_OPTIONS } from '@owlat/shared/tlsPolicy';
import type { ImapConfig } from './config.js';
import type { ConvexClient } from './convex.js';
import { ImapConnection } from './connection.js';
import type { AuthRateLimiter } from './rateLimit.js';
import { logger } from './logger.js';
import { startImapTlsReload } from './tlsReload.js';

/** The IMAPS cipher policy, shared with the SMTP listeners. */
const TLS_POLICY: TlsOptions = HARDENED_SERVER_TLS_OPTIONS;

interface ConnectionAccounting {
	totalActive: number;
	perIp: Map<string, number>;
}

export function startImapServer(
	config: ImapConfig,
	convex: ConvexClient,
	rateLimiter: AuthRateLimiter
): { server: TcpServer | TlsServer; stopTlsReload: () => void } {
	const accounting: ConnectionAccounting = {
		totalActive: 0,
		perIp: new Map(),
	};

	const makeHandler = (tls: boolean) => (socket: import('net').Socket) => {
		// A dual-stack listener reports IPv4 peers as `::ffff:a.b.c.d`; unmap so
		// one host is counted under one key whichever family it arrived on.
		const ip = unmapIpv4(socket.remoteAddress ?? 'unknown');
		const perIp = (accounting.perIp.get(ip) ?? 0) + 1;
		if (perIp > config.maxConnectionsPerIp) {
			socket.write('* BYE Too many connections from this IP\r\n');
			socket.end();
			return;
		}
		if (accounting.totalActive >= config.maxClients) {
			socket.write('* BYE Server connection limit reached\r\n');
			socket.end();
			return;
		}
		accounting.perIp.set(ip, perIp);
		accounting.totalActive += 1;
		socket.on('close', () => {
			accounting.totalActive = Math.max(0, accounting.totalActive - 1);
			const remaining = (accounting.perIp.get(ip) ?? 1) - 1;
			if (remaining <= 0) accounting.perIp.delete(ip);
			else accounting.perIp.set(ip, remaining);
		});

		new ImapConnection(socket, config, convex, rateLimiter, ip, tls);
	};

	if (config.tls) {
		const handler = makeHandler(true);
		const server = createPlainServer(
			{ ...TLS_POLICY, cert: config.tls.cert, key: config.tls.key },
			handler
		);
		// A renewed certificate on the mail-certs volume is swapped in place.
		const reloader = startImapTlsReload(server, config.tls, TLS_POLICY);
		server.listen(config.port, config.listenAddress, () => {
			logger.info({ port: config.port, listen: config.listenAddress }, 'IMAPS listening (TLS)');
		});
		server.on('error', (err) => logger.error({ err }, 'TLS server error'));
		return { server, stopTlsReload: () => reloader?.stop() };
	}

	// Dev fallback — bind a plain TCP server. NOT for production.
	if (process.env['NODE_ENV'] === 'production') {
		throw new Error(
			'IMAP refusing to start in production without TLS cert/key. ' +
				'Set IMAP_TLS_CERT/IMAP_TLS_KEY or mount certs at /opt/owlat/certs.'
		);
	}
	logger.warn('TLS cert/key not configured — starting in plaintext mode (dev only)');
	const server = createTcpServer(makeHandler(false));
	server.listen(config.port, config.listenAddress, () => {
		logger.info(
			{ port: config.port, listen: config.listenAddress },
			'IMAP listening (plain — dev only)'
		);
	});
	server.on('error', (err) => logger.error({ err }, 'TCP server error'));
	return { server, stopTlsReload: () => {} };
}
