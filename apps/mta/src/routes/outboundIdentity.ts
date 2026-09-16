/**
 * Outbound identity status + on-demand re-check (master-key protected).
 *
 * The installer's identity gate reads `/health`, which reports the verdict the
 * last sweep STORED. An operator who fixes a PTR record therefore stays blocked
 * until the next hourly sweep: re-running the installer brings no fresh
 * observation (`docker compose up -d` leaves an unchanged container running, so
 * there is no boot sweep either), and the install fails again on DNS that is
 * already correct. `POST /identity/recheck` is the way out — it re-observes
 * every configured address from live DNS and answers with the fresh verdicts in
 * the same shape `/health` uses, so one evaluator reads both.
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';
import { logger } from '../monitoring/logger.js';
import {
	outboundIdentityStatus,
	refreshOutboundIdentity,
} from '../scaling/outboundIdentityRefresh.js';

export function createOutboundIdentityRoutes(redis: Redis, config: MtaConfig) {
	const app = new Hono();

	app.use('*', masterKeyAuth(config));

	app.get('/', async (c) => c.json({ ips: await outboundIdentityStatus(redis, config) }));

	app.post('/recheck', async (c) => {
		try {
			await refreshOutboundIdentity(redis, config);
		} catch (err) {
			// A resolver failure is itself an observation the sweeps record; answer
			// with whatever is stored rather than a 500 the installer cannot act on.
			logger.warn({ err }, 'On-demand outbound identity re-check failed');
		}
		return c.json({ ips: await outboundIdentityStatus(redis, config) });
	});

	return app;
}
