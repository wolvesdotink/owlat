/**
 * Credential management API routes (master-key protected)
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import * as credentials from '../auth/credentials.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';

export function createCredentialRoutes(redis: Redis, config: MtaConfig) {
	const app = new Hono();

	// All credential routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// Create credential
	app.post('/', async (c) => {
		const body = await c.req.json<{ organizationId: string; name: string }>();
		if (!body.organizationId || !body.name) {
			return c.json({ error: 'organizationId and name are required' }, 400);
		}
		const result = await credentials.createCredential(redis, body.organizationId, body.name);
		return c.json({ success: true, apiKey: result.apiKey, credential: result.credential });
	});

	// List credentials (optionally filtered by org)
	app.get('/', async (c) => {
		const orgId = c.req.query('organizationId');
		if (orgId) {
			const result = await credentials.listCredentials(redis, orgId);
			return c.json({ credentials: result });
		}
		const result = await credentials.listAllCredentials(redis);
		return c.json({ credentials: result });
	});

	// Revoke credential
	app.delete('/:apiKey', async (c) => {
		const apiKey = c.req.param('apiKey');
		const result = await credentials.revokeCredential(redis, apiKey);
		if (!result) return c.json({ error: 'Credential not found' }, 404);
		return c.json({ success: true });
	});

	return app;
}
