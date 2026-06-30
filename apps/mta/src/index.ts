/**
 * owlat-mta — Custom Email Sending Infrastructure
 *
 * Entry point: starts HTTP server, GroupMQ workers, bounce SMTP server,
 * and periodic intelligence crons (DNSBL checking, warming evaluation).
 */

import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { getRedis, closeRedis } from './redis.js';
import { createApp } from './server.js';
import { createEmailQueue, createEmailWorker } from './queue/setup.js';
import { createBounceServer, startBounceServer } from './bounce/server.js';
import {
	createSubmissionServer,
	createImplicitTlsSubmissionServer,
	startSubmissionServer,
} from './smtp/submissionServer.js';
import { initializePools } from './scaling/ipPool.js';
import { runFcrdnsSelfCheck } from './scaling/fcrdns.js';
import { startDnsblChecker } from './intelligence/dnsbl.js';
import { initializeWarming, evaluateDay } from './intelligence/warming.js';
import * as orgLimits from './intelligence/orgLimits.js';
import { pool } from './smtp/connectionPool.js';
import { seedFromConfig } from './smtp/dkimStore.js';
import { seedProfiles } from './config/ispProfiles.js';
import { startLeaderElection, isLeader, stopLeaderElection } from './lib/leaderElection.js';
import { fetchPostmasterData } from './monitoring/postmaster.js';
import { checkRotationStatus, activatePendingKey } from './smtp/dkimRotation.js';
import type { DkimRotationNotifier } from './smtp/dkimRotation.js';
import { generateAndSendReports as sendTlsReports } from './smtp/tlsRpt.js';
import { notifyConvex } from './webhooks/convexNotifier.js';
import { logger } from './monitoring/logger.js';

async function main() {
	logger.info('Starting owlat-mta...');

	// ── 1. Load configuration ──
	const config = loadConfig();
	logger.info(
		{
			port: config.port,
			bouncePort: config.bouncePort,
			transactionalIps: config.ipPools.transactional,
			campaignIps: config.ipPools.campaign,
			concurrency: config.workerConcurrency,
			dkimDomains: Object.keys(config.dkimKeys),
		},
		'Configuration loaded'
	);

	// ── 1b. Set org rate limit defaults ──
	orgLimits.setDefaults(config.orgLimits.defaultDailyLimit, config.orgLimits.defaultHourlyLimit);

	// ── 2. Configure SMTP connection pool ──
	pool.configure(config.smtpPool);
	pool.startEviction();
	logger.info({ smtpPool: config.smtpPool }, 'SMTP connection pool configured');

	// Distributed connection coordination will be enabled after Redis connects (step 3)

	// ── 3. Connect to Redis ──
	const redis = getRedis(config.redisUrl);
	await redis.ping();
	logger.info('Redis connected');

	// ── 3a. Enable distributed pool coordination ──
	pool.enableDistributedCoordination(redis, config.smtpPoolGlobalMaxPerHost, config.serverId);
	logger.info({ globalMaxPerHost: config.smtpPoolGlobalMaxPerHost }, 'Distributed pool coordination enabled');

	// ── 3b. Seed DKIM keys from env var into Redis ──
	await seedFromConfig(redis, config.dkimKeys);

	// ── 3c. Seed ISP profiles into Redis (preserves runtime overrides) ──
	await seedProfiles(redis);

	// ── 4. Initialize IP pools in Redis ──
	await initializePools(redis, config.ipPools);

	// ── 4b. FCrDNS self-check (non-blocking) ──
	// Verify every sending IP's PTR forward-confirms and matches its EHLO name.
	// WARNs per misconfigured IP; never blocks startup.
	runFcrdnsSelfCheck(config).catch((err) => {
		logger.warn({ err }, 'FCrDNS self-check failed to run');
	});

	// ── 5. Initialize warming for all IPs ──
	const allIps = [...new Set([...config.ipPools.transactional, ...config.ipPools.campaign])];
	for (const ip of allIps) {
		await initializeWarming(redis, ip);
	}

	// ── 6. Create GroupMQ queue and worker ──
	const queue = createEmailQueue(redis);
	const worker = createEmailWorker(queue, redis, config);

	// ── 7. Start HTTP server ──
	const app = createApp(queue, redis, config);
	const server = serve(
		{ fetch: app.fetch, port: config.port },
		(info) => {
			logger.info({ port: info.port }, 'HTTP server listening');
		}
	);

	// ── 8. Start bounce SMTP server ──
	let bounceServer: ReturnType<typeof createBounceServer> | undefined;
	try {
		bounceServer = createBounceServer(config, redis);
		await startBounceServer(bounceServer, config.bouncePort);
	} catch (err) {
		logger.warn({ err, port: config.bouncePort }, 'Bounce server failed to start (port may require root)');
	}

	// ── 8b. Start SMTP submission server (if enabled) ──
	//
	// createSubmissionServer() throws when TLS material is missing — we must NOT
	// swallow that into a warning and keep running, because the alternative is an
	// insecure/broken AUTH listener. Build the server (fail-fast on config) first,
	// then only soften a transient listen() failure (e.g. port requires root).
	let submissionServer: ReturnType<typeof createSubmissionServer> | undefined;
	if (config.submissionEnabled) {
		submissionServer = createSubmissionServer(queue, redis, config);
		try {
			await startSubmissionServer(submissionServer, config.submissionPort);
		} catch (err) {
			logger.warn({ err, port: config.submissionPort }, 'Submission server failed to start');
		}
	}

	// ── 8c. Start implicit-TLS submission server (465, if enabled) ──
	//
	// RFC 8314 §3.3/§7.3-preferred transport: the whole connection is wrapped in
	// TLS, so there is no plaintext window for AUTH to be stripped. Same
	// fail-fast-on-missing-TLS / soften-transient-listen as the 587 listener.
	let implicitTlsSubmissionServer:
		| ReturnType<typeof createImplicitTlsSubmissionServer>
		| undefined;
	if (config.submissionImplicitTlsEnabled) {
		implicitTlsSubmissionServer = createImplicitTlsSubmissionServer(queue, redis, config);
		try {
			await startSubmissionServer(implicitTlsSubmissionServer, config.submissionImplicitTlsPort);
		} catch (err) {
			logger.warn(
				{ err, port: config.submissionImplicitTlsPort },
				'Implicit-TLS submission server failed to start',
			);
		}
	}

	// ── 9. Start leader election for periodic tasks ──
	startLeaderElection(redis, config.serverId);

	// ── 10. Start DNSBL checker (periodic, every 15 min — leader only) ──
	const dnsblInterval = startDnsblChecker(redis, config);

	// ── 11. Start warming evaluation cron (daily check — leader only) ──
	const warmingInterval = setInterval(async () => {
		if (!isLeader()) return; // Skip if not leader
		for (const ip of allIps) {
			try {
				await evaluateDay(redis, ip, config);
			} catch (err) {
				logger.error({ err, ip }, 'Warming evaluation failed');
			}
		}
	}, 60 * 60 * 1000); // Every hour; evaluateDay is idempotent per UTC day (lastEvaluatedDate guard), so it advances the schedule at most once/day

	// ── 12. Start Google Postmaster data fetcher (every hour — leader only) ──
	const postmasterInterval = setInterval(async () => {
		if (!isLeader()) return;
		try {
			await fetchPostmasterData(redis, config);
		} catch (err) {
			logger.error({ err }, 'Postmaster data fetch failed');
		}
	}, 60 * 60 * 1000);

	// ── 13. Start TLS-RPT daily report generation (every 24h — leader only) ──
	const tlsRptInterval = setInterval(async () => {
		if (!isLeader()) return;
		try {
			await sendTlsReports(redis, config.ehloHostname, `postmaster@${config.returnPathDomain}`, queue);
		} catch (err) {
			logger.error({ err }, 'TLS-RPT generation failed');
		}
	}, 24 * 60 * 60 * 1000);

	// ── 14. Check DKIM key rotation status (every 6h — leader only) ──
	// On auto-activation, propagate the new selector back to Convex so the
	// customer's `dnsRecords` + `verifyDomain` track the rotated key (RFC 6376
	// §3.6.1). Fire-and-forget with the notifier's own retry/DLQ.
	const notifyDkimRotation: DkimRotationNotifier = async (rotation) => {
		await notifyConvex(
			{
				event: 'dkim.rotated',
				domain: rotation.domain,
				selector: rotation.selector,
				dnsRecord: rotation.dnsRecord,
				phase: rotation.phase,
				timestamp: Date.now(),
			},
			config,
			redis
		).catch(() => {});
	};
	const dkimRotationInterval = setInterval(async () => {
		if (!isLeader()) return;
		try {
			const rotationStatus = await checkRotationStatus(redis);
			for (const entry of rotationStatus) {
				if (entry.action === 'pending_ready') {
					logger.info({ domain: entry.domain, details: entry.details }, 'Auto-activating DKIM pending key');
					await activatePendingKey(redis, entry.domain, false, undefined, notifyDkimRotation);
				} else if (entry.action === 'needs_rotation') {
					logger.warn({ domain: entry.domain, details: entry.details }, 'DKIM key rotation recommended');
				}
			}
		} catch (err) {
			logger.error({ err }, 'DKIM rotation check failed');
		}
	}, 6 * 60 * 60 * 1000);

	// ── 15. Start GroupMQ worker ──
	await worker.run();
	logger.info('GroupMQ worker started');

	// ── Graceful shutdown (P5.3) ──
	//
	// Matches stop_grace_period: 45s in the compose templates — we target
	// a 40s drain so Docker's SIGKILL never fires. Idempotent: a second
	// signal during drain is ignored.
	//
	// The hard-exit watchdog guarantees termination even if a subsystem
	// (worker.close, pool.closeAll, Redis) hangs forever. The alternative
	// — hanging past Docker's grace period — results in a SIGKILL anyway,
	// which is strictly worse because it skips the partial cleanup that's
	// already happened.
	const SHUTDOWN_DEADLINE_MS = 40_000;
	let shuttingDown = false;

	const shutdown = async (signal: string) => {
		if (shuttingDown) {
			logger.warn({ signal }, 'Shutdown already in progress — ignoring duplicate signal');
			return;
		}
		shuttingDown = true;

		logger.info({ signal }, 'Shutdown signal received');

		// Last-resort hard exit if drain hangs.
		const watchdog = setTimeout(() => {
			logger.fatal(
				{ deadlineMs: SHUTDOWN_DEADLINE_MS },
				'Shutdown deadline exceeded — forcing exit',
			);
			process.exit(1);
		}, SHUTDOWN_DEADLINE_MS);
		watchdog.unref();

		// Stop accepting new work
		clearInterval(dnsblInterval);
		clearInterval(warmingInterval);
		clearInterval(postmasterInterval);
		clearInterval(tlsRptInterval);
		clearInterval(dkimRotationInterval);

		// Close HTTP server
		if (typeof server.close === 'function') {
			server.close();
		}

		// Stop bounce server
		if (bounceServer) {
			bounceServer.close();
		}

		// Stop submission server
		if (submissionServer) {
			submissionServer.close();
		}

		// Stop implicit-TLS submission server
		if (implicitTlsSubmissionServer) {
			implicitTlsSubmissionServer.close();
		}

		// Drain worker (wait for in-flight jobs)
		try {
			await worker.close();
			logger.info('Worker drained');
		} catch (err) {
			logger.error({ err }, 'Worker drain failed');
		}

		// Drain and close SMTP connection pool
		await pool.closeAll();

		// Release leadership
		await stopLeaderElection(redis, config.serverId);

		// Close Redis
		await closeRedis();
		logger.info('Shutdown complete');
		clearTimeout(watchdog);
		process.exit(0);
	};

	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));

	logger.info('owlat-mta fully started and ready');
}

main().catch((err) => {
	logger.fatal({ err }, 'Fatal startup error');
	process.exit(1);
});
