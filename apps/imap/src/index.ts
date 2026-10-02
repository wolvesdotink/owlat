/**
 * Owlat IMAP server entry point.
 */

import IORedis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { IMAP_WIRE_VERSION } from '@owlat/shared/imapWire';
import { loadConfig } from './config.js';
import { createConvexClient, fn } from './convex.js';
import { installImapShutdown, startImapServer } from './server.js';
import { AuthRateLimiter } from './rateLimit.js';
import { logger } from './logger.js';
import {
	awaitWireCompatibility,
	startWireReports,
	type WireHandshakeDeps,
} from './wireHandshake.js';
import { installCrashHandlers } from '@owlat/shared/nodeShutdown';
import { pathToFileURL } from 'node:url';

export async function main() {
	const config = loadConfig();
	const convex = createConvexClient(config);

	// Report this server's release and wire version, and serve only once the
	// backend speaks its contract (ADR-0063).
	const owlatVersion = process.env['OWLAT_VERSION'] || 'dev';
	const identity = {
		instanceId: randomUUID(),
		hostLabel: hostname(),
		owlatVersion,
		wireVersion: IMAP_WIRE_VERSION,
		startedAt: Date.now(),
	};
	const handshake: WireHandshakeDeps = {
		report: () => convex.mutation(fn.reportServer, identity),
		owlatVersion,
		log: logger,
	};
	if ((await awaitWireCompatibility(handshake)) === 'refuse') {
		process.exit(1);
	}

	let redis: IORedis | null = null;
	if (config.redisUrl) {
		redis = new IORedis(config.redisUrl, {
			lazyConnect: false,
			maxRetriesPerRequest: 2,
			enableOfflineQueue: false,
		});
		redis.on('error', (err) => {
			logger.warn({ err }, 'redis error — auth rate limiter will fail-open');
		});
	} else {
		// Production never reaches here: loadConfig refuses to boot without
		// REDIS_URL unless IMAP_ALLOW_UNTHROTTLED_AUTH=true. So this is either a
		// dev run or a deliberate opt-out — both worth saying plainly rather than
		// in the old "fails open" phrasing, which read like a safe degraded mode.
		logger.warn(
			'REDIS_URL not set — LOGIN brute-force protection is OFF: password guessing ' +
				'against port 993 is unlimited. Production boots refuse this unless ' +
				'IMAP_ALLOW_UNTHROTTLED_AUTH=true.'
		);
	}

	const rateLimiter = new AuthRateLimiter(redis, config.authRateLimit);
	const imap = startImapServer(config, convex, rateLimiter);
	// A shutdown the backend asked for (it stopped serving this server's
	// contract) still drains normally, but exits non-zero.
	let exitCode = 0;
	let stopReports = () => {};
	const shutdown = installImapShutdown(imap, {
		disconnect: () => {
			stopReports();
			redis?.disconnect();
		},
		exit: (code) => process.exit(code || exitCode),
	});
	stopReports = startWireReports(handshake, () => {
		exitCode = 1;
		void shutdown.shutdown('IMAP wire version no longer served');
	}).stop;
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
	// Crash channels first, so a failure inside main()'s own startup is reported
	// through this logger and ends the process, rather than printing a bare trace
	// (uncaughtException) or, for a rejection, being swallowed entirely.
	installCrashHandlers({ log: (message, detail) => logger.fatal({ err: detail }, message) });
	void main().catch((err) => {
		logger.error({ err }, 'fatal startup error');
		process.exit(1);
	});
}
