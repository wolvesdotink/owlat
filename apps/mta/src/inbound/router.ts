/**
 * Inbound Email Router
 *
 * Routes incoming emails based on configurable per-domain rules.
 * Supports 5 routing modes: endpoint, accept, hold, bounce, reject.
 */

import type Redis from 'ioredis';
import { parseAddress } from '@owlat/shared';
import { logger } from '../monitoring/logger.js';

export type RouteMode = 'endpoint' | 'accept' | 'hold' | 'bounce' | 'reject';

export interface InboundRoute {
	id: string;
	domain: string;
	address: string; // '*' for wildcard catch-all
	mode: RouteMode;
	/** HTTP webhook URL (for 'endpoint' mode) */
	endpointUrl?: string;
	/** Organization ID for correlation */
	organizationId?: string;
	createdAt: number;
}

const ROUTE_PREFIX = 'mta:inbound-routes:';
const ROUTE_INDEX = 'mta:inbound-route-ids';

function routeKey(domain: string, address: string): string {
	return `${ROUTE_PREFIX}${domain}:${address}`;
}

/**
 * Find the best matching route for a recipient address
 * Priority: exact match → wildcard
 */
export async function findRoute(
	redis: Redis,
	recipientEmail: string
): Promise<InboundRoute | null> {
	// Route the recipient through the shared parser so inbound routing agrees
	// with every other address derivation (unwraps "Name <addr>", lowercases).
	const parsed = parseAddress(recipientEmail);
	if (!parsed) return null;
	const atIndex = parsed.address.lastIndexOf('@');
	const localPart = parsed.address.slice(0, atIndex);
	const domain = parsed.address.slice(atIndex + 1);
	if (!domain || !localPart) return null;

	// Try exact match first
	const exactData = await redis.get(routeKey(domain, localPart));
	if (exactData) {
		try { return JSON.parse(exactData); } catch { /* fall through */ }
	}

	// Try wildcard
	const wildcardData = await redis.get(routeKey(domain, '*'));
	if (wildcardData) {
		try { return JSON.parse(wildcardData); } catch { /* fall through */ }
	}

	return null;
}

/**
 * Create or update a route
 */
export async function createRoute(
	redis: Redis,
	route: Omit<InboundRoute, 'id' | 'createdAt'>
): Promise<InboundRoute> {
	const id = `${route.domain}:${route.address}`;
	const fullRoute: InboundRoute = {
		...route,
		id,
		createdAt: Date.now(),
	};

	await redis.set(routeKey(route.domain, route.address), JSON.stringify(fullRoute));
	await redis.sadd(ROUTE_INDEX, id);

	logger.info({ id, mode: route.mode, domain: route.domain }, 'Inbound route created');
	return fullRoute;
}

/**
 * Remove a route
 */
export async function removeRoute(redis: Redis, domain: string, address: string): Promise<boolean> {
	const key = routeKey(domain, address);
	const result = await redis.del(key);
	await redis.srem(ROUTE_INDEX, `${domain}:${address}`);
	return result > 0;
}

/**
 * List all routes
 */
export async function listRoutes(redis: Redis): Promise<InboundRoute[]> {
	const ids = await redis.smembers(ROUTE_INDEX);
	const routes: InboundRoute[] = [];

	for (const id of ids) {
		const data = await redis.get(`${ROUTE_PREFIX}${id}`);
		if (data) {
			try { routes.push(JSON.parse(data)); } catch { /* skip */ }
		}
	}

	return routes;
}
