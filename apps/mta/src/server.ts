/**
 * Hono HTTP Server setup
 *
 * Mounts all routes with authentication middleware.
 */

import { Hono, type Context } from 'hono';
import type { Queue } from 'groupmq';
import type Redis from 'ioredis';
import type { EmailJob } from './types.js';
import type { MtaConfig } from './config.js';
import type { OrgCredential } from './auth/credentials.js';
import { lookupCredential } from './auth/credentials.js';
import { timingSafeStringEqual } from './auth/timingSafe.js';
import { createSendHandler } from './routes/send.js';
import { createHealthHandler, createMetricsHandler } from './routes/health.js';
import { createCredentialRoutes } from './routes/credentials.js';
import { createOrgLimitsRoutes } from './routes/orgLimits.js';
import { createSuppressionRoutes } from './routes/suppression.js';
import { createDkimRoutes } from './routes/dkim.js';
import { createPoolRulesRoutes } from './routes/poolRules.js';
import { createInboundRoutes } from './routes/inboundRoutes.js';
import { createMailboxRoutes } from './routes/mailboxes.js';
import { createDeliveryLogRoutes } from './routes/deliveryLogs.js';
import { createQueueRoutes } from './routes/queue.js';
import { createDlqRoutes } from './routes/dlq.js';
import { createIspProfileRoutes } from './routes/ispProfiles.js';
import { createIpReputationRoutes } from './routes/ipReputation.js';
import { createScanRoutes } from './routes/scan.js';
import { logger } from './monitoring/logger.js';

/** Auth context set by the authentication middleware */
export interface AuthContext {
	/** True when authenticated with the master MTA_API_KEY */
	isMasterKey: boolean;
	/** Set when authenticated with a per-org credential */
	orgCredential?: OrgCredential;
}

/**
 * Create the Hono HTTP app with all routes
 */
export function createApp(queue: Queue<EmailJob>, redis: Redis, config: MtaConfig): Hono {
	const app = new Hono();

	// ── Authentication middleware for /send routes ──
	const authMiddleware = async (c: Context, next: () => Promise<void>) => {
		const authHeader = c.req.header('Authorization');
		const token = authHeader?.replace('Bearer ', '');

		if (!token) {
			logger.warn({ ip: c.req.header('x-forwarded-for') }, 'Unauthorized API request');
			return c.json({ error: 'Unauthorized' }, 401);
		}

		// Check master key first (constant-time to avoid timing side-channels)
		if (timingSafeStringEqual(token, config.apiKey)) {
			c.set('auth', { isMasterKey: true } satisfies AuthContext);
			await next();
			return;
		}

		// Check per-org credential
		const credential = await lookupCredential(redis, token);
		if (credential) {
			c.set('auth', { isMasterKey: false, orgCredential: credential } satisfies AuthContext);
			await next();
			return;
		}

		logger.warn({ ip: c.req.header('x-forwarded-for') }, 'Unauthorized API request');
		return c.json({ error: 'Unauthorized' }, 401);
	};

	app.use('/send/*', authMiddleware);
	app.use('/send', authMiddleware);

	// ── Routes ──
	app.post('/send', createSendHandler(queue, redis));
	app.get('/health', createHealthHandler(redis, config));
	app.get('/metrics', createMetricsHandler());

	// Credential management (master-key protected internally)
	app.route('/credentials', createCredentialRoutes(redis, config));

	// Organization rate limits (master-key protected internally)
	app.route('/org-limits', createOrgLimitsRoutes(redis, config));

	// Suppression list (master-key protected internally)
	app.route('/suppression', createSuppressionRoutes(redis, config));

	// DKIM key management (master-key protected internally)
	app.route('/dkim', createDkimRoutes(redis, config));

	// Pool routing rules (master-key protected internally)
	app.route('/pool-rules', createPoolRulesRoutes(redis, config));

	// Inbound email routing (master-key protected internally)
	app.route('/inbound/routes', createInboundRoutes(redis, config));

	// Personal-mailbox cache (master-key protected internally)
	app.route('/mailboxes', createMailboxRoutes(redis, config));

	// Delivery logs (master-key protected internally)
	app.route('/delivery-logs', createDeliveryLogRoutes(redis, config));

	// Queue inspection (master-key protected internally)
	app.route('/queue', createQueueRoutes(queue, redis, config));

	// Dead letter queue (master-key protected internally)
	app.route('/dlq', createDlqRoutes(redis, config));

	// ISP profiles (master-key protected internally)
	app.route('/isp-profiles', createIspProfileRoutes(redis, config));

	// IP reputation dashboard (master-key protected internally)
	app.route('/ip-reputation', createIpReputationRoutes(redis, config));

	// Attachment scanning (ClamAV + file type validation, master-key protected)
	app.route('/scan', createScanRoutes(config));

	// Root endpoint
	app.get('/', (c) =>
		c.json({
			service: 'owlat-mta',
			version: '0.1.0', // x-release-version (kept in sync by scripts/release.ts)
			docs: 'POST /send, GET /health, GET /metrics, /credentials, /org-limits, /suppression, /dkim, /pool-rules, /inbound/routes, /delivery-logs, /queue, /dlq, /isp-profiles, /ip-reputation, /scan',
		})
	);

	return app;
}
