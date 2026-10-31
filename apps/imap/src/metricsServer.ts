/**
 * Plain-HTTP `/metrics` listener. The IMAP server has no HTTP surface of its
 * own (port 993 speaks IMAP only), so the Prometheus endpoint gets a small
 * listener next to it. It is unauthenticated like the MTA's `/metrics`: compose
 * does not publish the port, so only the Docker network reaches it, and the
 * registry holds process counters, never mailbox data.
 */

import { createServer, type Server } from 'node:http';
import type { MetricsSource } from '@owlat/shared/nodeMetrics';
import { logger } from './logger.js';

export interface MetricsServerHandle {
	readonly server: Server;
	/** Stop accepting scrapes and drop open keep-alive connections. */
	stop(): void;
}

export function startMetricsServer(
	source: MetricsSource,
	options: { port: number; host: string }
): MetricsServerHandle {
	const server = createServer((req, res) => {
		// The listener is unauthenticated, so the request target is untrusted:
		// `new URL` throws on targets like `//[`, and a throw here would reach the
		// crash handler and stop the mail server.
		let path: string;
		try {
			path = new URL(req.url ?? '/', 'http://localhost').pathname;
		} catch {
			res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request\n');
			return;
		}
		if (req.method !== 'GET' || path !== '/metrics') {
			res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found\n');
			return;
		}
		source.metrics().then(
			(body) => {
				res.writeHead(200, { 'Content-Type': source.contentType }).end(body);
			},
			(err: unknown) => {
				logger.warn({ err }, 'metrics render failed');
				res.writeHead(500, { 'Content-Type': 'text/plain' }).end('metrics unavailable\n');
			}
		);
	});
	// A metrics port that cannot bind must not take the mail server down with it:
	// without this listener the error would surface as an uncaught exception.
	server.on('error', (err) => {
		logger.error({ err, port: options.port }, 'metrics listener failed; /metrics is unavailable');
	});
	server.listen(options.port, options.host, () => {
		logger.info({ port: options.port }, 'metrics listener ready');
	});
	return {
		server,
		stop() {
			server.close();
			server.closeAllConnections();
		},
	};
}
