/**
 * Inbound route management API routes (master-key protected)
 */

import { Hono } from 'hono';
import { v } from 'convex/values';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import type { RouteMode } from '../inbound/router.js';
import * as router from '../inbound/router.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';
import { readJsonBody } from '../lib/jsonBody.js';

const VALID_MODES: RouteMode[] = ['endpoint', 'accept', 'hold', 'bounce', 'reject'];

const isRouteMode = (mode: string): mode is RouteMode => (VALID_MODES as string[]).includes(mode);

const routeBody = v.object({
	domain: v.string(),
	address: v.string(),
	// Membership is checked below, with its own message.
	mode: v.string(),
	endpointUrl: v.optional(v.string()),
	organizationId: v.optional(v.string()),
});

export function createInboundRoutes(redis: Redis, config: MtaConfig) {
	const app = new Hono();

	// All inbound-route routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// Create or update route
	app.post('/', async (c) => {
		const read = await readJsonBody(c, routeBody);
		if (!read.ok) return read.response;
		const body = read.value;

		if (!body.domain || !body.address || !body.mode) {
			return c.json({ error: 'domain, address, and mode are required' }, 400);
		}

		const { mode } = body;
		if (!isRouteMode(mode)) {
			return c.json({ error: `mode must be one of: ${VALID_MODES.join(', ')}` }, 400);
		}

		if (mode === 'endpoint' && !body.endpointUrl) {
			return c.json({ error: 'endpointUrl is required for endpoint mode' }, 400);
		}

		const route = await router.createRoute(redis, {
			domain: body.domain,
			address: body.address,
			mode,
			endpointUrl: body.endpointUrl,
			organizationId: body.organizationId,
		});

		return c.json({ success: true, route });
	});

	// List all routes
	app.get('/', async (c) => {
		const routes = await router.listRoutes(redis);
		return c.json({ routes });
	});

	// Remove route
	app.delete('/:domain/:address', async (c) => {
		const domain = c.req.param('domain');
		const address = c.req.param('address');
		const result = await router.removeRoute(redis, domain, address);
		if (!result) return c.json({ error: 'Route not found' }, 404);
		return c.json({ success: true });
	});

	return app;
}
