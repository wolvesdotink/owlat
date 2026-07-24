/**
 * Dead Letter Queue API Routes
 *
 * Master-key protected endpoints for managing failed webhook events.
 */

import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import * as dlq from '../webhooks/dlq.js';
import { notifyConvex } from '../webhooks/convexNotifier.js';
import { logger } from '../monitoring/logger.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';

export function createDlqRoutes(redis: Redis, config: MtaConfig) {
	const app = new Hono();

	// All DLQ routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// GET / — list failed events
	app.get('/', async (c) => {
		const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 500);
		const offset = parseInt(c.req.query('offset') ?? '0', 10);

		try {
			const result = await dlq.listFailed(redis, limit, offset);
			return c.json(result);
		} catch {
			logger.error({ operation: 'dlq_list', category: 'storage' }, 'Failed to list DLQ entries');
			return c.json({ error: 'Failed to list DLQ entries' }, 500);
		}
	});

	// GET /stats — DLQ statistics
	app.get('/stats', async (c) => {
		try {
			const stats = await dlq.getStats(redis);
			return c.json({
				total: stats.total,
				oldestAge: stats.oldestTimestamp ? Date.now() - stats.oldestTimestamp : null,
				newestAge: stats.newestTimestamp ? Date.now() - stats.newestTimestamp : null,
			});
		} catch {
			logger.error({ operation: 'dlq_stats', category: 'storage' }, 'Failed to get DLQ stats');
			return c.json({ error: 'Failed to get DLQ stats' }, 500);
		}
	});

	// POST /:dlqId/retry — retry a specific failed event
	app.post('/:dlqId/retry', async (c) => {
		const dlqId = c.req.param('dlqId');

		try {
			const entry = await dlq.claimOne(redis, dlqId, {
				owner: `manual:${randomUUID()}`,
				now: Date.now(),
				requireDue: false,
				enforceAutoLimit: false,
				autoRetryLimit: dlq.WEBHOOK_DLQ_AUTO_RETRY_LIMIT,
			});
			if (!entry) {
				return c.json({ error: 'DLQ entry unavailable or already claimed' }, 409);
			}

			// Attempt redelivery
			const success = await notifyConvex(entry.event, config, undefined, {
				deadline: entry.claim.expiresAt - 5_000,
			});
			if (success) {
				await dlq.settleClaim(redis, entry, 'success', Date.now());
				return c.json({ success: true, delivered: true });
			}

			// Update retry attempt count
			await dlq.settleClaim(redis, entry, 'failure', Date.now());

			return c.json({ success: false, delivered: false, attempts: entry.attempts + 1 });
		} catch {
			logger.error(
				{ operation: 'dlq_retry_one', category: 'storage' },
				'Failed to retry DLQ entry'
			);
			return c.json({ error: 'Failed to retry' }, 500);
		}
	});

	// POST /retry-all — retry all DLQ entries
	app.post('/retry-all', async (c) => {
		try {
			const ids = await dlq.getAllIds(redis);
			let delivered = 0;
			let failed = 0;

			for (const dlqId of ids) {
				const entry = await dlq.claimOne(redis, dlqId, {
					owner: `manual-all:${randomUUID()}`,
					now: Date.now(),
					requireDue: false,
					enforceAutoLimit: false,
					autoRetryLimit: dlq.WEBHOOK_DLQ_AUTO_RETRY_LIMIT,
				});
				if (!entry) continue;

				const success = await notifyConvex(entry.event, config, undefined, {
					deadline: entry.claim.expiresAt - 5_000,
				});
				if (success) {
					await dlq.settleClaim(redis, entry, 'success', Date.now());
					delivered++;
				} else {
					await dlq.settleClaim(redis, entry, 'failure', Date.now());
					failed++;
				}
			}

			return c.json({ success: true, delivered, failed, total: ids.length });
		} catch {
			logger.error(
				{ operation: 'dlq_retry_all', category: 'storage' },
				'Failed to retry all DLQ entries'
			);
			return c.json({ error: 'Failed to retry all' }, 500);
		}
	});

	// DELETE /:dlqId — discard a specific entry
	app.delete('/:dlqId', async (c) => {
		const dlqId = c.req.param('dlqId');

		try {
			const removed = await dlq.removeOne(redis, dlqId);
			return c.json({ success: true, removed });
		} catch {
			logger.error(
				{ operation: 'dlq_remove_one', category: 'storage' },
				'Failed to remove DLQ entry'
			);
			return c.json({ error: 'Failed to remove' }, 500);
		}
	});

	return app;
}
