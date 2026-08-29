import { getOptional } from './env';
import { isDevDeployment } from '../devShortcuts/_guard';
/**
 * Shared CORS header utilities for HTTP endpoints.
 *
 * Usage:
 *   import { corsHeaders, publicCorsHeaders } from './lib/cors';
 *
 *   // For API endpoints (with Authorization header support)
 *   const origin = request.headers.get('Origin');
 *   const headers = corsHeaders('GET, POST, OPTIONS', origin);
 *
 *   // For public endpoints (no Authorization needed)
 *   const headers = publicCorsHeaders('POST, OPTIONS');
 */

/**
 * Allowed origins for private API endpoints.
 *
 * Set `ALLOWED_ORIGINS` as a comma-separated list, e.g.
 * "https://app.owlat.app,http://localhost:3000".
 *
 * Resolved lazily (per request), not at import: in PRODUCTION the silent
 * `http://localhost:3000` fallback is dropped (L10) — reflecting a loopback
 * origin in `Access-Control-Allow-Origin` on a real deployment is a
 * misconfiguration. When `ALLOWED_ORIGINS` is unset we fall back to
 * `SITE_URL` / `ADMIN_SITE_URL`, and if none of those are set the request fails
 * closed. Dev deployments (`OWLAT_DEV_MODE`) keep the loopback default so a local
 * checkout works with no env. Evaluating this at import time would also throw on
 * the Convex component schema-analysis path, where env vars are unavailable.
 */
function allowedOrigins(): string[] {
	const configured = getOptional('ALLOWED_ORIGINS');
	if (configured) {
		const parsed = configured
			.split(',')
			.map((o) => o.trim())
			.filter(Boolean);
		if (parsed.length > 0) return parsed;
	}

	if (isDevDeployment()) {
		return ['http://localhost:3000'];
	}

	const derived = [getOptional('SITE_URL'), getOptional('ADMIN_SITE_URL')].filter(
		(o): o is string => Boolean(o)
	);
	if (derived.length === 0) {
		throw new Error(
			'Missing CORS allow-list: set ALLOWED_ORIGINS (or SITE_URL) in production; the localhost fallback is dev-only'
		);
	}
	return derived;
}

function resolveOrigin(requestOrigin: string | null): string {
	const origins = allowedOrigins();
	if (!requestOrigin) return origins[0]!;
	return origins.includes(requestOrigin) ? requestOrigin : origins[0]!;
}

/**
 * Generate CORS headers for API endpoints that require Authorization.
 * Restricts to allowed origins only.
 */
export function corsHeaders(
	methods: string = 'GET, POST, PUT, DELETE, OPTIONS',
	requestOrigin?: string | null
): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': resolveOrigin(requestOrigin ?? null),
		'Access-Control-Allow-Methods': methods,
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		'Access-Control-Allow-Credentials': 'true',
		Vary: 'Origin',
	};
}

/**
 * Generate CORS headers for public endpoints (forms, unsubscribe, etc.).
 * These stay open ('*') because they must be accessible from any origin.
 */
export function publicCorsHeaders(methods: string = 'GET, POST, OPTIONS'): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': methods,
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': '86400',
	};
}
