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
		const body = await c.req.json<{
			organizationId: string;
			name: string;
			allowedDomains?: string[];
		}>();
		if (!body.organizationId || !body.name) {
			return c.json({ error: 'organizationId and name are required' }, 400);
		}
		if (body.allowedDomains !== undefined && !Array.isArray(body.allowedDomains)) {
			return c.json({ error: 'allowedDomains must be an array of domains' }, 400);
		}
		const result = await credentials.createCredential(
			redis,
			body.organizationId,
			body.name,
			body.allowedDomains
		);
		return c.json({ success: true, apiKey: result.apiKey, credential: result.credential });
	});

	// List credentials (optionally filtered by org).
	//
	// `?includeKeys=1` returns the FULL, un-redacted API keys instead of the
	// truncated `owlat_xxxx...` form. It is gated by the same master-key auth as
	// every other route here (Convex backend / migration use only) and exists so
	// the allowedDomains backfill can PATCH each credential by its full key. The
	// default stays redacted so any less-trusted surface never gets usable keys.
	app.get('/', async (c) => {
		const orgId = c.req.query('organizationId');
		if (orgId) {
			if (c.req.query('includeKeys') === '1') {
				const result = await credentials.listCredentialsWithKeys(redis, orgId);
				return c.json({ credentials: result });
			}
			const result = await credentials.listCredentials(redis, orgId);
			return c.json({ credentials: result });
		}
		const result = await credentials.listAllCredentials(redis);
		return c.json({ credentials: result });
	});

	// Set a credential's allowedDomains (the H2 verified-sending-domain set).
	// Rewrites only that field, preserving name/createdAt/lastUsedAt. Used by the
	// allowedDomains backfill migration; idempotent.
	app.patch('/:apiKey', async (c) => {
		const apiKey = c.req.param('apiKey');
		const body = await c.req
			.json<{ allowedDomains?: unknown }>()
			.catch(() => null as { allowedDomains?: unknown } | null);
		if (
			!body ||
			!Array.isArray(body.allowedDomains) ||
			!body.allowedDomains.every((d) => typeof d === 'string')
		) {
			return c.json({ error: 'allowedDomains must be an array of domain strings' }, 400);
		}
		const updated = await credentials.setAllowedDomains(
			redis,
			apiKey,
			body.allowedDomains as string[]
		);
		if (!updated) return c.json({ error: 'Credential not found' }, 404);
		return c.json({ success: true });
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
