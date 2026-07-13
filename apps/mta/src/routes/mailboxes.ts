/**
 * Mailbox cache management API (master-key protected).
 *
 * Convex pushes mailbox CRUD into this endpoint so the MTA can resolve
 * inbound recipients in O(1) Redis lookups without round-tripping back
 * to Convex from the SMTP onRcptTo hot path.
 *
 *   POST /mailboxes/cache/{address}   -> create/refresh cache entry
 *   POST /mailboxes/inbound-tls-policy -> set the instance TLS acceptance floor
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
import { setInboundTlsRequired } from '../inbound/inboundTlsPolicy.js';

interface CacheEntryBody {
	mailboxId: string;
	organizationId: string;
	quotaBytes?: number;
	usedBytes?: number;
	isInboundTlsRequired?: boolean;
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
		if (body.isInboundTlsRequired !== undefined && typeof body.isInboundTlsRequired !== 'boolean') {
			return c.json({ error: 'isInboundTlsRequired must be a boolean' }, 400);
		}
		await setMailboxCache(redis, address, {
			mailboxId: body.mailboxId,
			organizationId: body.organizationId,
			quotaBytes: body.quotaBytes,
			usedBytes: body.usedBytes ?? 0,
		});
		if (body.isInboundTlsRequired !== undefined) {
			await setInboundTlsRequired(redis, body.isInboundTlsRequired);
		}
		return c.json({ success: true });
	});

	// Update the instance-wide SMTP acceptance floor immediately after an
	// owner/admin changes it in Convex. Missing state defaults to required.
	app.post('/inbound-tls-policy', async (c) => {
		const body = await c.req.json<{ isRequired?: unknown }>();
		if (typeof body.isRequired !== 'boolean') {
			return c.json({ error: 'isRequired must be a boolean' }, 400);
		}
		await setInboundTlsRequired(redis, body.isRequired);
		return c.json({ success: true, isRequired: body.isRequired });
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
