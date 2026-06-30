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

export function createIspProfileRoutes(redis: Redis, config: MtaConfig): Hono {
	const app = new Hono();

	// All isp-profiles routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// GET /isp-profiles — list all profiles
	app.get('/', async (c) => {
		const profiles = await ispProfiles.listProfiles(redis);
		return c.json({ profiles });
	});

	// GET /isp-profiles/:domain — get profile for a specific domain
	app.get('/:domain', async (c) => {
		const domain = c.req.param('domain');
		const profile = await ispProfiles.getProfile(redis, domain);
		return c.json({ domain, profile });
	});

	// PUT /isp-profiles/:domain — update or create a profile
	app.put('/:domain', async (c) => {
		const domain = c.req.param('domain');

		let body: Record<string, unknown>;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON body' }, 400);
		}

		try {
			const profile = await ispProfiles.setProfile(redis, domain, {
				defaultRate: typeof body['defaultRate'] === 'number' ? body['defaultRate'] : undefined,
				ceiling: typeof body['ceiling'] === 'number' ? body['ceiling'] : undefined,
				floor: typeof body['floor'] === 'number' ? body['floor'] : undefined,
				backoffFactor: typeof body['backoffFactor'] === 'number' ? body['backoffFactor'] : undefined,
				recoveryFactor: typeof body['recoveryFactor'] === 'number' ? body['recoveryFactor'] : undefined,
			});
			return c.json({ domain, profile });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Unknown error';
			return c.json({ error: message }, 400);
		}
	});

	// DELETE /isp-profiles/:domain — remove custom profile (reverts to default)
	app.delete('/:domain', async (c) => {
		const domain = c.req.param('domain');
		const deleted = await ispProfiles.deleteProfile(redis, domain);
		return c.json({ deleted });
	});

	return app;
}
