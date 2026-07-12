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
	/**
	 * When set, `endpoint` forwards to this URL are HMAC-signed with this secret
	 * (x-mta-signature/x-mta-timestamp), marking a *system* route delivering to
	 * one of our own trusted Convex webhooks rather than an untrusted customer
	 * endpoint. Never persisted for user-created routes.
	 */
	systemSecret?: string;
	createdAt: number;
}

const ROUTE_PREFIX = 'mta:inbound-routes:';
const ROUTE_INDEX = 'mta:inbound-route-ids';

function routeKey(domain: string, address: string): string {
	return `${ROUTE_PREFIX}${domain}:${address}`;
}

// ─── TLS-RPT system route (RFC 8460) ────────────────────────────────

/** Synthetic id for the TLS-RPT reporting-address system route. */
export const TLS_RPT_SYSTEM_ROUTE_ID = '__system:tls-rpt__';
/** Convex webhook path the TLS-RPT system route delivers to. */
export const TLS_RPT_WEBHOOK_PATH = '/webhooks/mta-tls-report';

/** Config the inbound pipeline threads through to recognise the rua address. */
export interface TlsRptSystemRouteConfig {
	/** The operator's `_smtp._tls` `rua=` value (mailto: URI or bare address). */
	ruaAddress?: string;
	/** Convex deployment site URL, e.g. `https://acme.convex.site`. */
	convexSiteUrl: string;
	/** Shared MTA webhook secret used to HMAC-sign the forward. */
	webhookSecret: string;
}

/**
 * Normalise a TLS-RPT `rua=` value to a bare lowercase `local@domain` address,
 * stripping the `mailto:` scheme and any `?subject=` parameters (RFC 8460 §3).
 * Returns null for empty/`https:` reporting URIs (those are polled elsewhere,
 * not delivered as inbound mail) or anything without an `@`.
 */
export function parseRuaAddress(rua: string | undefined): string | null {
	if (!rua) return null;
	const trimmed = rua.trim();
	if (!trimmed) return null;
	const lower = trimmed.toLowerCase();
	if (lower.startsWith('https:') || lower.startsWith('http:')) return null;
	const withoutScheme = lower.startsWith('mailto:') ? lower.slice('mailto:'.length) : lower;
	const addr = withoutScheme.split('?')[0]?.trim();
	if (!addr || addr.indexOf('@') < 1) return null;
	return addr;
}

/**
 * Build the synthetic TLS-RPT system route delivering to the dedicated Convex
 * webhook. Not persisted — constructed in-memory by {@link findRoute} when a
 * recipient matches the configured rua address. Takes the already-parsed rua
 * address (via {@link parseRuaAddress}) so the caller parses it exactly once.
 */
export function buildTlsRptSystemRoute(
	config: TlsRptSystemRouteConfig,
	parsedRua: string | null
): InboundRoute {
	const base = config.convexSiteUrl.replace(/\/+$/, '');
	const atIndex = parsedRua ? parsedRua.lastIndexOf('@') : -1;
	return {
		id: TLS_RPT_SYSTEM_ROUTE_ID,
		domain: parsedRua && atIndex >= 0 ? parsedRua.slice(atIndex + 1) : '',
		address: parsedRua && atIndex >= 0 ? parsedRua.slice(0, atIndex) : '',
		mode: 'endpoint',
		endpointUrl: `${base}${TLS_RPT_WEBHOOK_PATH}`,
		systemSecret: config.webhookSecret,
		createdAt: 0,
	};
}

/**
 * Find the best matching route for a recipient address
 * Priority: exact match → wildcard
 */
export async function findRoute(
	redis: Redis,
	recipientEmail: string,
	system?: TlsRptSystemRouteConfig
): Promise<InboundRoute | null> {
	// Route the recipient through the shared parser so inbound routing agrees
	// with every other address derivation (unwraps "Name <addr>", lowercases).
	const parsed = parseAddress(recipientEmail);
	if (!parsed) return null;
	const atIndex = parsed.address.lastIndexOf('@');
	const localPart = parsed.address.slice(0, atIndex);
	const domain = parsed.address.slice(atIndex + 1);
	if (!domain || !localPart) return null;

	// System route: the operator's TLS-RPT reporting address (rua=) delivers to
	// the dedicated Convex webhook, never a user mailbox. Checked before the
	// route table so an operator can't shadow it with a conflicting entry.
	const ruaAddress = parseRuaAddress(system?.ruaAddress);
	if (system && ruaAddress && parsed.address.toLowerCase() === ruaAddress) {
		return buildTlsRptSystemRoute(system, ruaAddress);
	}

	// Try exact match first
	const exactData = await redis.get(routeKey(domain, localPart));
	if (exactData) {
		try {
			return JSON.parse(exactData);
		} catch {
			/* fall through */
		}
	}

	// Try wildcard
	const wildcardData = await redis.get(routeKey(domain, '*'));
	if (wildcardData) {
		try {
			return JSON.parse(wildcardData);
		} catch {
			/* fall through */
		}
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
			try {
				routes.push(JSON.parse(data));
			} catch {
				/* skip */
			}
		}
	}

	return routes;
}
