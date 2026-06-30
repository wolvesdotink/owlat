/**
 * Suppression List API Routes
 *
 * Master-key protected CRUD endpoints for the MTA-level suppression list.
 * Includes bulk operations, export, and statistics.
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import * as suppressionList from '../intelligence/suppressionList.js';
import type { SuppressionReason } from '../intelligence/suppressionList.js';
import { logger } from '../monitoring/logger.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';

/**
 * Create the suppression list route group
 */
export function createSuppressionRoutes(redis: Redis, config: MtaConfig): Hono {
	const app = new Hono();

	// All suppression routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// POST / — add addresses to suppression list
	app.post('/', async (c) => {
		let body: { emails: string[]; reason?: SuppressionReason; source?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON body' }, 400);
		}

		if (!body.emails || !Array.isArray(body.emails) || body.emails.length === 0) {
			return c.json({ error: 'Missing required field: emails (non-empty array)' }, 400);
		}

		const reason: SuppressionReason = body.reason ?? 'manual';

		try {
			await Promise.all(
				body.emails.map((email) =>
					suppressionList.suppress(redis, email, reason, { source: body.source })
				)
			);
			return c.json({ success: true, suppressed: body.emails.length });
		} catch (err) {
			logger.error({ err }, 'Failed to add to suppression list');
			return c.json({ error: 'Failed to suppress addresses' }, 500);
		}
	});

	// POST /bulk — add up to 10,000 addresses in one request
	app.post('/bulk', async (c) => {
		let body: {
			entries: Array<{ email: string; reason: SuppressionReason; source?: string }>;
		};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON body' }, 400);
		}

		if (!body.entries || !Array.isArray(body.entries)) {
			return c.json({ error: 'Missing required field: entries (array)' }, 400);
		}

		if (body.entries.length > 10_000) {
			return c.json({ error: 'Maximum 10,000 entries per request' }, 400);
		}

		try {
			const result = await suppressionList.suppressBulk(redis, body.entries);
			return c.json({ success: true, ...result });
		} catch (err) {
			logger.error({ err }, 'Failed to bulk suppress');
			return c.json({ error: 'Failed to bulk suppress' }, 500);
		}
	});

	// GET /export — paginated export with metadata
	app.get('/export', async (c) => {
		const reason = c.req.query('reason') as SuppressionReason | undefined;
		const cursor = c.req.query('cursor');
		const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined;

		try {
			const result = await suppressionList.exportSuppressionList(redis, {
				reason,
				cursor,
				limit,
			});
			return c.json(result);
		} catch (err) {
			logger.error({ err }, 'Failed to export suppression list');
			return c.json({ error: 'Failed to export' }, 500);
		}
	});

	// GET /stats — suppression statistics
	app.get('/stats', async (c) => {
		try {
			const stats = await suppressionList.getSuppressionStats(redis);
			return c.json(stats);
		} catch (err) {
			logger.error({ err }, 'Failed to get suppression stats');
			return c.json({ error: 'Failed to get stats' }, 500);
		}
	});

	// DELETE /:email — remove from suppression list
	app.delete('/:email', async (c) => {
		const email = decodeURIComponent(c.req.param('email'));

		try {
			const removed = await suppressionList.unsuppress(redis, email);
			return c.json({ success: true, removed });
		} catch (err) {
			logger.error({ err, email }, 'Failed to remove from suppression list');
			return c.json({ error: 'Failed to unsuppress address' }, 500);
		}
	});

	// GET /check/:email — check suppression status
	app.get('/check/:email', async (c) => {
		const email = decodeURIComponent(c.req.param('email'));

		try {
			const status = await suppressionList.getSuppressionStatus(redis, email);
			return c.json(status);
		} catch (err) {
			logger.error({ err, email }, 'Failed to check suppression status');
			return c.json({ error: 'Failed to check status' }, 500);
		}
	});

	return app;
}
