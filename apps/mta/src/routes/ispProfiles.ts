/**
 * ISP Profile Admin Routes
 *
 * Master-key protected routes for managing ISP sending profiles at runtime.
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import * as ispProfiles from '../config/ispProfiles.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';
import { isOutboundTlsMode } from '@owlat/shared';

export function createIspProfileRoutes(redis: Redis, config: MtaConfig): Hono {
	const app = new Hono();

	// All isp-profiles routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// GET /isp-profiles — list all profiles
	app.get('/', async (c) => {
		const profiles = await ispProfiles.listProfiles(redis);
		return c.json({ profiles });
	});

	// GET /isp-profiles/:provider — get one destination-provider profile
	app.get('/:provider', async (c) => {
		const provider = c.req.param('provider');
		const profile = await ispProfiles.getProfile(redis, provider);
		return c.json({ provider, profile });
	});

	// PUT /isp-profiles/:domain — update or create a profile
	app.put('/:provider', async (c) => {
		const provider = c.req.param('provider');

		let body: Record<string, unknown>;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON body' }, 400);
		}

		try {
			const profile = await ispProfiles.setProfile(redis, provider, {
				defaultRate: typeof body['defaultRate'] === 'number' ? body['defaultRate'] : undefined,
				ceiling: typeof body['ceiling'] === 'number' ? body['ceiling'] : undefined,
				floor: typeof body['floor'] === 'number' ? body['floor'] : undefined,
				backoffFactor:
					typeof body['backoffFactor'] === 'number' ? body['backoffFactor'] : undefined,
				recoveryFactor:
					typeof body['recoveryFactor'] === 'number' ? body['recoveryFactor'] : undefined,
				tlsMode:
					typeof body['tlsMode'] === 'string' && isOutboundTlsMode(body['tlsMode'])
						? body['tlsMode']
						: undefined,
				maxConnections:
					typeof body['maxConnections'] === 'number' ? body['maxConnections'] : undefined,
				maxDeliveriesPerConnection:
					typeof body['maxDeliveriesPerConnection'] === 'number'
						? body['maxDeliveriesPerConnection']
						: undefined,
			});
			return c.json({ provider, profile });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Unknown error';
			return c.json({ error: message }, 400);
		}
	});

	// DELETE /isp-profiles/:domain — remove custom profile (reverts to default)
	app.delete('/:provider', async (c) => {
		const provider = c.req.param('provider');
		const deleted = await ispProfiles.deleteProfile(redis, provider);
		return c.json({ deleted });
	});

	return app;
}
