/**
 * Delivery Log API Routes
 *
 * Master-key protected endpoints for querying the persistent delivery event log.
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import {
	queryDeliveryLogs,
	getDeliveryLogStats,
	getMessageEvents,
	type DeliveryStatus,
} from '../monitoring/deliveryLogger.js';
import { logger } from '../monitoring/logger.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';

export function createDeliveryLogRoutes(redis: Redis, config: MtaConfig) {
	const app = new Hono();

	// All delivery-log routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// GET / — query delivery logs
	app.get('/', async (c) => {
		try {
			const result = await queryDeliveryLogs(redis, {
				date: c.req.query('date'),
				startDate: c.req.query('startDate'),
				endDate: c.req.query('endDate'),
				orgId: c.req.query('orgId'),
				status: c.req.query('status') as DeliveryStatus | undefined,
				domain: c.req.query('domain'),
				limit: c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined,
				cursor: c.req.query('cursor'),
			});
			return c.json(result);
		} catch (err) {
			logger.error({ err }, 'Failed to query delivery logs');
			return c.json({ error: 'Failed to query delivery logs' }, 500);
		}
	});

	// GET /stats — aggregated counts
	app.get('/stats', async (c) => {
		const date = c.req.query('date') ?? new Date().toISOString().split('T')[0]!;
		const orgId = c.req.query('orgId');

		try {
			const stats = await getDeliveryLogStats(redis, date, orgId);
			return c.json({ date, orgId: orgId ?? null, stats });
		} catch (err) {
			logger.error({ err }, 'Failed to get delivery log stats');
			return c.json({ error: 'Failed to get stats' }, 500);
		}
	});

	// GET /:messageId — all events for a specific message
	app.get('/:messageId', async (c) => {
		const messageId = c.req.param('messageId');

		try {
			const events = await getMessageEvents(redis, messageId);
			return c.json({ messageId, events });
		} catch (err) {
			logger.error({ err, messageId }, 'Failed to get message events');
			return c.json({ error: 'Failed to get message events' }, 500);
		}
	});

	return app;
}
