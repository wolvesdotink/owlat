/**
 * Organization Rate Limits API Routes
 *
 * Master-key protected CRUD endpoints for per-org send rate limits.
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import * as orgLimits from '../intelligence/orgLimits.js';
import { logger } from '../monitoring/logger.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';

/**
 * Create the org limits route group
 */
export function createOrgLimitsRoutes(redis: Redis, config: MtaConfig): Hono {
	const app = new Hono();

	// All org-limits routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// POST / — set limits for an organization
	app.post('/', async (c) => {
		let body: { organizationId: string; dailyLimit?: number; hourlyLimit?: number };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON body' }, 400);
		}

		if (!body.organizationId) {
			return c.json({ error: 'Missing required field: organizationId' }, 400);
		}

		if (body.dailyLimit === undefined && body.hourlyLimit === undefined) {
			return c.json({ error: 'Must provide at least one of: dailyLimit, hourlyLimit' }, 400);
		}

		try {
			await orgLimits.setOrgLimits(redis, body.organizationId, body.dailyLimit, body.hourlyLimit);
			const usage = await orgLimits.getOrgUsage(redis, body.organizationId);
			return c.json({ success: true, ...usage });
		} catch (err) {
			logger.error({ err, orgId: body.organizationId }, 'Failed to set org limits');
			return c.json({ error: 'Failed to set limits' }, 500);
		}
	});

	// GET /:orgId — get usage + limits
	app.get('/:orgId', async (c) => {
		const orgId = c.req.param('orgId');
		try {
			const usage = await orgLimits.getOrgUsage(redis, orgId);
			return c.json(usage);
		} catch (err) {
			logger.error({ err, orgId }, 'Failed to get org usage');
			return c.json({ error: 'Failed to get usage' }, 500);
		}
	});

	// GET /:orgId/usage — alias for above
	app.get('/:orgId/usage', async (c) => {
		const orgId = c.req.param('orgId');
		try {
			const usage = await orgLimits.getOrgUsage(redis, orgId);
			return c.json(usage);
		} catch (err) {
			logger.error({ err, orgId }, 'Failed to get org usage');
			return c.json({ error: 'Failed to get usage' }, 500);
		}
	});

	return app;
}
