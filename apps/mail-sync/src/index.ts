/**
 * Owlat mail-sync worker entry point.
 *
 * - AccountManager holds one persistent IMAP connection per connected external
 *   account (inbound sync, near-real-time via IDLE).
 * - HTTP server exposes /send + /test for Convex (outbound relay + cred check),
 *   /reconcile so a freshly connected mailbox starts syncing at once, and
 *   /remote-ops, the nudge to replay changes made in Owlat on the provider.
 */

import { loadConfig } from './config.js';
import { createConvexClient } from './convex.js';
import { AccountManager } from './accountManager.js';
import { startServer } from './server.js';
import { drainSentCopies } from './send.js';
import { startSeedProbeSweeper } from './seedProbeRunner.js';
import { logger } from './logger.js';
import { installCrashHandlers, installShutdown, pinoShutdownLog } from '@owlat/shared/nodeShutdown';
import { pathToFileURL } from 'node:url';

export async function main(): Promise<void> {
	const config = loadConfig();
	const convex = createConvexClient(config);

	const manager = new AccountManager(convex, config);
	await manager.start();

	const server = startServer(config, convex, {
		requestReconcile: () => {
			void manager.requestReconcile();
		},
		requestRemoteOps: (accountId) => manager.requestRemoteOps(accountId),
	});
	// Deliverability seed-probe sweep. With no seed mailboxes connected — the
	// default — every pass is an empty no-op (D2).
	const stopSeedSweeper = startSeedProbeSweeper(convex);

	// Stop the HTTP server first, then let every account connection log out of
	// IMAP, and every Sent copy a /send already answered for finish its APPEND,
	// before the process exits. 25s sits under the compose stop_grace_period of
	// 30s, so the watchdog ends a wedged logout, not Docker.
	installShutdown({
		server,
		drain: async () => {
			stopSeedSweeper();
			await Promise.all([manager.stop(), drainSentCopies()]);
		},
		timeoutMs: 25_000,
		log: pinoShutdownLog(logger),
	});
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
