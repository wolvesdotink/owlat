/**
 * Mailbox cache management API (master-key protected).
 *
 * Convex pushes mailbox CRUD into this endpoint so the MTA can resolve
 * inbound recipients in O(1) Redis lookups without round-tripping back
 * to Convex from the SMTP onRcptTo hot path.
 *
 *   POST /mailboxes/cache/{address}   -> create/refresh cache entry
 *   DELETE /mailboxes/cache/{address} -> remove cache entry
 *   GET /mailboxes/cache              -> list cached addresses
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import {
	setMailboxCache,
	deleteMailboxCache,
	listMailboxCache,
} from '../inbound/mailboxResolver.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';

interface CacheEntryBody {
	mailboxId: string;
	organizationId: string;
	quotaBytes?: number;
	usedBytes?: number;
}

export function createMailboxRoutes(redis: Redis, config: MtaConfig) {
	const app = new Hono();

	// All mailbox-cache routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// Populate or refresh a mailbox cache entry.
	app.post('/cache/:address', async (c) => {
		const address = c.req.param('address');
		if (!address || !address.includes('@')) {
			return c.json({ error: 'Invalid address' }, 400);
		}
		const body = await c.req.json<CacheEntryBody>();
		if (!body.mailboxId || !body.organizationId) {
			return c.json({ error: 'mailboxId and organizationId are required' }, 400);
		}
		await setMailboxCache(redis, address, {
			mailboxId: body.mailboxId,
			organizationId: body.organizationId,
			quotaBytes: body.quotaBytes,
			usedBytes: body.usedBytes ?? 0,
		});
		return c.json({ success: true });
	});

	// Remove cache entry.
	app.delete('/cache/:address', async (c) => {
		const address = c.req.param('address');
		const removed = await deleteMailboxCache(redis, address);
		if (!removed) return c.json({ error: 'Not in cache' }, 404);
		return c.json({ success: true });
	});

	// List cached addresses (debug).
	app.get('/cache', async (c) => {
		const addresses = await listMailboxCache(redis);
		return c.json({ addresses });
	});

	return app;
}
