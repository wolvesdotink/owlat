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
import { startBounceTlsReload } from './bounce/tlsReload.js';
import {
	createSubmissionServer,
	createImplicitTlsSubmissionServer,
	startSubmissionServer,
} from './smtp/submissionServer.js';
import { initializePools } from './scaling/ipPool.js';
import { logNatSourceAddresses } from './smtp/sourceAddress.js';
import { refreshOutboundIdentity } from './scaling/outboundIdentityRefresh.js';
import { flushPendingIpReadinessAlerts } from './scaling/ipReadinessAlerts.js';
import { startDnsblChecker } from './intelligence/dnsbl.js';
import { configuredAuditIps, defaultIpAuditDeps, startIpAuditor } from './scaling/ipAudit.js';
import { initializeWarming, evaluateDay } from './intelligence/warming.js';
import {
	sweepExpiredSuppressions,
	SUPPRESSION_SWEEP_BATCH,
} from './intelligence/suppressionList.js';
import * as orgLimits from './intelligence/orgLimits.js';
import { pool } from './smtp/connectionPool.js';
import { assertLeaseProtocolCutoverSafe } from './smtp/poolGlobalCap.js';
import { seedFromConfig } from './smtp/dkimStore.js';
import { initMtaSecretBox } from './lib/secretBox.js';
import { seedProfiles } from './config/ispProfiles.js';
import { startLeaderElection, isLeader, stopLeaderElection } from './lib/leaderElection.js';
import { fetchPostmasterData } from './monitoring/postmaster.js';
import { checkRotationStatus, activatePendingKey } from './smtp/dkimRotation.js';
import type { DkimRotationNotifier } from './smtp/dkimRotation.js';
import { generateAndSendReports as sendTlsReports } from './smtp/tlsRpt.js';
import { notifyConvex } from './webhooks/convexNotifier.js';
import { sweepWebhookDlq } from './webhooks/dlqSweeper.js';
import { logger } from './monitoring/logger.js';
import { stopIntake } from './lib/stopIntake.js';
import { fireAndForget } from './lib/fireAndForget.js';
import { installCrashHandlers, installShutdown, pinoShutdownLog } from '@owlat/shared/nodeShutdown';
import { pathToFileURL } from 'node:url';

export async function main() {
	logger.info('Starting owlat-mta...');

	// ── 1. Load configuration ──
	const config = loadConfig();
	// Bind the transport-secret box to the boot-validated MTA_SECRET so every
	// seal/unseal (DKIM keys, pending rotation keys) shares one authoritative
	// secret source rather than re-reading the environment.
	initMtaSecretBox(config.mtaSecret);
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
	// Advisory only: a NATed install keeps sending, but the operator must learn
	// here, not from misattributed reputation, that its pools share one address.
	logNatSourceAddresses([...config.ipPools.transactional, ...config.ipPools.campaign], logger);

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
	if (config.smtpPoolCoordinationProtocol === 'leases-v1') {
		await assertLeaseProtocolCutoverSafe(redis);
	}
	pool.enableDistributedCoordination(
		redis,
		config.smtpPoolGlobalMaxPerHost,
		config.serverId,
		config.smtpPoolCoordinationProtocol ?? 'legacy-v0'
	);
	logger.info(
		{
			globalMaxPerHost: config.smtpPoolGlobalMaxPerHost,
			protocol: config.smtpPoolCoordinationProtocol,
		},
		'Distributed pool coordination enabled'
	);

	// ── 3b. Seed DKIM keys from env var into Redis ──
	await seedFromConfig(redis, config.dkimKeys);

	// ── 3c. Seed ISP profiles into Redis (preserves runtime overrides) ──
	await seedProfiles(redis);

	// ── 4. Initialize IP pools in Redis ──
	await initializePools(redis, config.ipPools, config.allowUnverifiedFcrdns);

	// ── 4b. FCrDNS readiness gate ──
	// Complete the first observation before a worker can select an IP. A fresh,
	// never-verified address therefore cannot race its quarantine at startup.
	await refreshOutboundIdentity(redis, config);
	await flushPendingIpReadinessAlerts(redis, config);

	// ── 4c. Finish this process's first DNSBL sweep, then elect the cron leader ──
	// The boot sweep is unconditional because an existing leader in a rolling
	// deployment may still have the old IP configuration. Only periodic work is
	// leader-gated; generation CAS makes overlapping boot observations safe.
	const dnsblInterval = await startDnsblChecker(redis, config, isLeader);
	startLeaderElection(redis, config.serverId);

	// Advisory pre-flight IP audit: port-25 egress, blocklists, FCrDNS, and the
	// /24 neighbourhood. It gates nothing, so it never delays or fails startup.
	const ipAuditInterval = startIpAuditor(redis, config, isLeader, defaultIpAuditDeps(config));

	// ── 5. Initialize warming for all IPs ──
	const allIps = configuredAuditIps(config);
	for (const ip of allIps) {
		await initializeWarming(redis, ip);
	}

	// ── 6. Create GroupMQ queue and worker ──
	const queue = createEmailQueue(redis);
	const { worker, stopHeartbeat } = createEmailWorker(queue, redis, config);

	// Recover routing/lifecycle callbacks automatically after a Convex outage.
	// The sweep is bounded and leader-gated; exhausted entries remain available
	// through the authenticated manual DLQ routes.
	const webhookDlqInterval = setInterval(async () => {
		if (!isLeader()) return;
		try {
			await flushPendingIpReadinessAlerts(redis, config);
			await sweepWebhookDlq(redis, config);
		} catch (err) {
			logger.error(
				{ err, operation: 'convex_webhook_dlq', category: 'automatic_retry' },
				'Automatic webhook recovery sweep failed'
			);
		}
	}, 60_000);

	// ── 7. Start HTTP server ──
	// Renewed inbound certificates are swapped into the port-25 listener (created
	// below) in place; /health reports whichever certificate is in service.
	let bounceServer: ReturnType<typeof createBounceServer> | undefined;
	const bounceTlsReload = startBounceTlsReload(config, () => bounceServer);
	const app = createApp(queue, redis, config, bounceTlsReload.currentCert);
	const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
		logger.info({ port: info.port }, 'HTTP server listening');
	});

	// ── 8. Start bounce SMTP server ──
	try {
		bounceServer = createBounceServer(config, redis);
		await startBounceServer(bounceServer, config.bouncePort);
	} catch (err) {
		logger.warn(
			{ err, port: config.bouncePort },
			'Bounce server failed to start (port may require root)'
		);
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
	let implicitTlsSubmissionServer: ReturnType<typeof createImplicitTlsSubmissionServer> | undefined;
	if (config.submissionImplicitTlsEnabled) {
		implicitTlsSubmissionServer = createImplicitTlsSubmissionServer(queue, redis, config);
		try {
			await startSubmissionServer(implicitTlsSubmissionServer, config.submissionImplicitTlsPort);
		} catch (err) {
			logger.warn(
				{ err, port: config.submissionImplicitTlsPort },
				'Implicit-TLS submission server failed to start'
			);
		}
	}

	// ── 10b. Re-verify outbound identity hourly (leader only) ──
	const fcrdnsInterval = setInterval(
		async () => {
			if (!isLeader()) return;
			try {
				await refreshOutboundIdentity(redis, config);
			} catch (err) {
				logger.error({ err }, 'Periodic outbound-IP readiness check failed');
			}
		},
		60 * 60 * 1000
	);

	// ── 10c. Reclaim expired temporary suppressions (hourly — leader only) ──
	// Only TEMPORARY suppressions are due-indexed, so this can never remove a
	// hard bounce or a complaint. It exists because the lazy expiry check in
	// `isSuppressed` only fires for an address somebody tries to mail again:
	// without a sweep, every soft-bounce suppression nobody retries would stay
	// on a list that grows forever on a Redis configured `noeviction`.
	const suppressionSweepInterval = setInterval(
		async () => {
			if (!isLeader()) return;
			try {
				// Drain in bounded batches so a backlog is cleared over one run
				// rather than one per hour, but stop well short of an unbounded walk.
				// The stop condition is `processed`, not `removed`: a batch that was
				// all keep/repair arms reclaims nothing while still consuming the
				// whole limit, and stopping on `removed` would leave the rest due.
				for (let batch = 0; batch < 20; batch += 1) {
					const swept = await sweepExpiredSuppressions(redis);
					if (swept.processed < SUPPRESSION_SWEEP_BATCH) break;
				}
			} catch (err) {
				logger.error({ err }, 'Expired-suppression sweep failed');
			}
		},
		60 * 60 * 1000
	);

	// ── 11. Start warming evaluation cron (daily check — leader only) ──
	const warmingInterval = setInterval(
		async () => {
			if (!isLeader()) return; // Skip if not leader
			for (const ip of allIps) {
				try {
					await evaluateDay(redis, ip, config);
				} catch (err) {
					logger.error({ err, ip }, 'Warming evaluation failed');
				}
			}
		},
		60 * 60 * 1000
	); // Every hour; evaluateDay is idempotent per UTC day (lastEvaluatedDate guard), so it advances the schedule at most once/day

	// ── 12. Start Google Postmaster data fetcher (every hour — leader only) ──
	const postmasterInterval = setInterval(
		async () => {
			if (!isLeader()) return;
			try {
				await fetchPostmasterData(redis, config);
			} catch {
				// Never attach raw Redis/provider errors: command metadata can contain
				// the OAuth access token being cached.
				logger.error(
					{ operation: 'postmaster.collection', trigger: 'scheduled', category: 'unexpected' },
					'Postmaster data fetch failed'
				);
			}
		},
		60 * 60 * 1000
	);
	// Do not wait an hour after a restart for the first observation. The collector
	// is internally idempotent and catches/logs provider failures. Keep the
	// rejection handler as a final boundary against future collector regressions.
	if (config.googlePostmaster && isLeader()) {
		void fetchPostmasterData(redis, config).catch(() =>
			logger.error(
				{ operation: 'postmaster.collection', trigger: 'initial', category: 'unexpected' },
				'Initial Postmaster data fetch failed'
			)
		);
	}

	// ── 13. Start TLS-RPT daily report generation (every 24h — leader only) ──
	const tlsRptInterval = setInterval(
		async () => {
			if (!isLeader()) return;
			try {
				await sendTlsReports(
					redis,
					config.ehloHostname,
					`postmaster@${config.returnPathDomain}`,
					queue
				);
			} catch (err) {
				logger.error({ err }, 'TLS-RPT generation failed');
			}
		},
		24 * 60 * 60 * 1000
	);

	// ── 14. Check DKIM key rotation status (every 6h — leader only) ──
	// On auto-activation, propagate the new selector back to Convex so the
	// customer's `dnsRecords` + `verifyDomain` track the rotated key (RFC 6376
	// §3.6.1). Fire-and-forget with the notifier's own retry/DLQ.
	const notifyDkimRotation: DkimRotationNotifier = async (rotation) => {
		await fireAndForget(
			notifyConvex(
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
			),
			logger,
			'dkim_rotation_notify'
		);
	};
	const dkimRotationInterval = setInterval(
		async () => {
			if (!isLeader()) return;
			try {
				const rotationStatus = await checkRotationStatus(redis);
				for (const entry of rotationStatus) {
					if (entry.action === 'pending_ready') {
						logger.info(
							{ domain: entry.domain, details: entry.details },
							'Auto-activating DKIM pending key'
						);
						await activatePendingKey(redis, entry.domain, false, undefined, notifyDkimRotation);
					} else if (entry.action === 'needs_rotation') {
						logger.warn(
							{ domain: entry.domain, details: entry.details },
							'DKIM key rotation recommended'
						);
					}
				}
			} catch (err) {
				logger.error({ err }, 'DKIM rotation check failed');
			}
		},
		6 * 60 * 60 * 1000
	);

	// ── 15. Start GroupMQ worker ──
	await worker.run();
	logger.info('GroupMQ worker started');

	// ── Graceful shutdown ──
	//
	// installShutdown stops the HTTP server, ignores a duplicate signal and holds
	// a ref'd watchdog, so a subsystem that hangs (worker.close, pool.closeAll,
	// Redis) ends in exit 1 at the deadline rather than in Docker's SIGKILL,
	// which would skip the cleanup already done. 40s drain for the 45s
	// stop_grace_period in the compose templates.
	//
	// The intake stops run at the signal (onShutdown): `drain` only starts once
	// every HTTP connection has ended, and the crons, the heartbeat and the SMTP
	// listeners must not keep going until then.
	installShutdown({
		server,
		onShutdown: () =>
			stopIntake({
				intervals: [
					dnsblInterval,
					ipAuditInterval,
					fcrdnsInterval,
					warmingInterval,
					postmasterInterval,
					tlsRptInterval,
					dkimRotationInterval,
					webhookDlqInterval,
					suppressionSweepInterval,
				],
				// Stop claiming liveness the moment we start draining.
				stops: [() => bounceTlsReload.stop(), stopHeartbeat],
				listeners: [
					[bounceServer, 'Bounce server close failed'],
					[submissionServer, 'Submission server close failed'],
					[implicitTlsSubmissionServer, 'Implicit-TLS submission server close failed'],
				],
				log: logger,
			}),
		drain: async () => {
			// Drain worker (wait for in-flight jobs)
			try {
				await worker.close();
				logger.info('Worker drained');
			} catch (err) {
				logger.error({ err }, 'Worker drain failed');
			}

			// Drain and close SMTP connection pool, release leadership, close Redis
			await pool.closeAll();
			await stopLeaderElection(redis, config.serverId);
			await closeRedis();
		},
		timeoutMs: 40_000,
		log: pinoShutdownLog(logger),
	});

	logger.info('owlat-mta fully started and ready');
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
	// Crash channels first, so a failure inside main()'s own startup is reported
	// through this logger and ends the process, rather than printing a bare trace
	// (uncaughtException) or, for a rejection, being swallowed entirely.
	installCrashHandlers({ log: (message, detail) => logger.fatal({ err: detail }, message) });
	void main().catch((err) => {
		logger.fatal({ err }, 'Fatal startup error');
		process.exit(1);
	});
}
