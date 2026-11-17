/**
 * Provider holds (master-key protected): which sending addresses a mailbox
 * provider has told us to slow down on, written by Convex from that provider's
 * own reputation feed. See intelligence/providerHolds.ts.
 */

import { Hono } from 'hono';
import { isIP } from 'node:net';
import { v } from 'convex/values';
import type Redis from 'ioredis';
import { isDestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import type { MtaConfig } from '../config.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';
import { readJsonBody } from '../lib/jsonBody.js';
import { replaceProviderHolds } from '../intelligence/providerHolds.js';

/** Far above any sending pool; it bounds one request, not the deployment. */
const MAX_HELD_ADDRESSES = 256;

const holdsBody = v.object({ provider: v.string(), ips: v.array(v.string()) });

export function createProviderHoldRoutes(redis: Redis, config: MtaConfig) {
	const app = new Hono();
	app.use('*', masterKeyAuth(config));

	app.put('/', async (c) => {
		const read = await readJsonBody(c, holdsBody);
		if (!read.ok) return read.response;
		const { provider, ips } = read.value;
		if (!isDestinationProviderKey(provider)) {
			return c.json({ error: 'provider must be a destination provider key' }, 400);
		}
		if (ips.length > MAX_HELD_ADDRESSES || ips.some((ip) => isIP(ip) === 0)) {
			return c.json({ error: `ips must be at most ${MAX_HELD_ADDRESSES} IP addresses` }, 400);
		}
		await replaceProviderHolds(redis, provider, [...new Set(ips)]);
		return c.json({ provider, ips: [...new Set(ips)].sort() });
	});

	return app;
}
