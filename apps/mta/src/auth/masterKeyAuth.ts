/**
 * Master-key authentication middleware for admin routes.
 *
 * The 13 admin route groups (queue, suppression, dkim, …) all gate on the
 * single master `MTA_API_KEY`. This factory replaces the inline auth checks
 * that each route group used to re-implement — several of which compared the
 * key with a plain `===`/`!==`, leaking it byte-by-byte via timing.
 */

import type { MiddlewareHandler } from 'hono';
import type { MtaConfig } from '../config.js';
import { timingSafeStringEqual } from './timingSafe.js';
import { logger } from '../monitoring/logger.js';

/** Hono middleware that gates a route on the master MTA_API_KEY using a
 *  constant-time comparison. Strips the `Bearer ` prefix from Authorization. */
export function masterKeyAuth(config: MtaConfig): MiddlewareHandler {
	return async (c, next) => {
		const token = c.req.header('Authorization')?.replace('Bearer ', '');

		if (token && timingSafeStringEqual(token, config.apiKey)) {
			await next();
			return;
		}

		logger.warn({ ip: c.req.header('x-forwarded-for') }, 'Unauthorized API request');
		return c.json({ error: 'Unauthorized' }, 401);
	};
}
