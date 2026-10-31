/**
 * ISP Profile Admin Routes
 *
 * Master-key protected routes for managing ISP sending profiles at runtime.
 */

import { Hono } from 'hono';
import { v } from 'convex/values';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import * as ispProfiles from '../config/ispProfiles.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';
import { readJsonBody } from '../lib/jsonBody.js';
import { isOutboundTlsMode } from '@owlat/shared';
import { isDestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import type { DestinationProviderProfile } from '../types.js';

const PROFILE_FIELDS = new Set([
	'defaultRate',
	'ceiling',
	'floor',
	'backoffFactor',
	'recoveryFactor',
	'tlsMode',
	'maxConnections',
	'maxDeliveriesPerConnection',
]);

function parseProfilePatch(body: unknown): Partial<DestinationProviderProfile> {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		throw new Error('Request body must be an object');
	}

	const values = body as Record<string, unknown>;
	for (const field of Object.keys(values)) {
		if (!PROFILE_FIELDS.has(field)) throw new Error(`Unknown profile field: ${field}`);
	}

	const patch: Partial<DestinationProviderProfile> = {};
	for (const field of [
		'defaultRate',
		'ceiling',
		'floor',
		'backoffFactor',
		'recoveryFactor',
		'maxConnections',
		'maxDeliveriesPerConnection',
	] as const) {
		if (!(field in values)) continue;
		const value = values[field];
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new Error(`${field} must be a finite number`);
		}
		patch[field] = value;
	}

	if ('tlsMode' in values) {
		const tlsMode = values['tlsMode'];
		if (typeof tlsMode !== 'string' || !isOutboundTlsMode(tlsMode)) {
			throw new Error('tlsMode is invalid');
		}
		patch.tlsMode = tlsMode;
	}

	return patch;
}

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
		const rawProvider = c.req.param('provider');
		if (!isDestinationProviderKey(rawProvider)) {
			return c.json({ error: `Unknown destination provider: ${rawProvider}` }, 400);
		}
		const provider = rawProvider;
		const profile = await ispProfiles.getProfile(redis, provider);
		return c.json({ provider, profile });
	});

	// PUT /isp-profiles/:provider — update a known provider profile
	app.put('/:provider', async (c) => {
		const rawProvider = c.req.param('provider');
		if (!isDestinationProviderKey(rawProvider)) {
			return c.json({ error: `Unknown destination provider: ${rawProvider}` }, 400);
		}
		const provider = rawProvider;

		// The patch's own parser checks every field and answers in its own words.
		const read = await readJsonBody(c, v.any());
		if (!read.ok) return read.response;

		try {
			const profile = await ispProfiles.setProfile(redis, provider, parseProfilePatch(read.value));
			return c.json({ provider, profile });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Unknown error';
			return c.json({ error: message }, 400);
		}
	});

	// DELETE /isp-profiles/:provider — remove custom profile (reverts to default)
	app.delete('/:provider', async (c) => {
		const rawProvider = c.req.param('provider');
		if (!isDestinationProviderKey(rawProvider)) {
			return c.json({ error: `Unknown destination provider: ${rawProvider}` }, 400);
		}
		const provider = rawProvider;
		const deleted = await ispProfiles.deleteProfile(redis, provider);
		return c.json({ deleted });
	});

	return app;
}
