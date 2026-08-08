/**
 * Owlat mail-sync worker entry point.
 *
 * - AccountManager holds one persistent IMAP connection per connected external
 *   account (inbound sync, near-real-time via IDLE).
 * - HTTP server exposes /send + /test for Convex (outbound relay + cred check).
 */

import { loadConfig } from './config.js';
import { createConvexClient } from './convex.js';
import { AccountManager } from './accountManager.js';
import { startServer } from './server.js';
import { startSeedProbeSweeper } from './seedProbeRunner.js';
import { logger } from './logger.js';
import { pathToFileURL } from 'node:url';

export async function main(): Promise<void> {
	const config = loadConfig();
	const convex = createConvexClient(config);

	const manager = new AccountManager(convex, config);
	await manager.start();

	const server = startServer(config, convex);
	// Deliverability seed-probe sweep. With no seed mailboxes connected — the
	// default — every pass is an empty no-op (D2).
	const stopSeedSweeper = startSeedProbeSweeper(convex);

	const shutdown = (signal: string) => {
		logger.info({ signal }, 'shutting down');
		void manager.stop();
		stopSeedSweeper();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(1), 10_000).unref();
	};
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
	void main().catch((err) => {
		logger.error({ err }, 'fatal startup error');
		process.exit(1);
	});
}
