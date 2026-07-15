/**
 * Per-domain outbound TLS mode override management (master-key protected).
 *
 * Mirrors the DKIM route: every endpoint requires the MTA master key. Lets an
 * operator raise (or lower) the TLS demand for a specific recipient domain on
 * top of the global `OUTBOUND_TLS_MODE`.
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';
import {
	listOutboundTlsOverrides,
	removeOutboundTlsOverride,
	setOutboundTlsOverride,
} from '../smtp/outboundTlsOverrides.js';
import { isOutboundTlsMode, OUTBOUND_TLS_MODES } from '../smtp/tlsPolicy.js';

export function createOutboundTlsRoutes(redis: Redis, config: MtaConfig) {
	const app = new Hono();

	// All outbound-TLS override routes require the master key (constant-time compare).
	app.use('*', masterKeyAuth(config));

	// List all per-domain overrides plus the global default.
	app.get('/', async (c) => {
		const overrides = await listOutboundTlsOverrides(redis);
		return c.json({ globalMode: config.outboundTlsMode ?? 'opportunistic', overrides });
	});

	// Set (or replace) a domain's override.
	app.post('/', async (c) => {
		const body = await c.req
			.json<{ domain?: string; mode?: string }>()
			.catch(() => ({}) as { domain?: string; mode?: string });
		if (!body.domain || !body.mode) {
			return c.json({ error: 'domain and mode are required' }, 400);
		}
		if (!isOutboundTlsMode(body.mode)) {
			return c.json({ error: `mode must be one of: ${OUTBOUND_TLS_MODES.join(', ')}` }, 400);
		}
		await setOutboundTlsOverride(redis, body.domain, body.mode);
		return c.json({ success: true, domain: body.domain.toLowerCase(), mode: body.mode });
	});

	// Remove a domain's override (reverts to the global default).
	app.delete('/:domain', async (c) => {
		const domain = c.req.param('domain');
		const removed = await removeOutboundTlsOverride(redis, domain);
		if (!removed) return c.json({ error: 'No override for domain' }, 404);
		return c.json({ success: true, domain: domain.toLowerCase() });
	});

	return app;
}
