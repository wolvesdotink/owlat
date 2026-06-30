import { getOptional } from './env';
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

// Allowed origins for private API endpoints.
// Set ALLOWED_ORIGINS env var as comma-separated list,
// e.g. "https://app.owlat.app,http://localhost:3000"
const ALLOWED_ORIGINS = (getOptional('ALLOWED_ORIGINS') || 'http://localhost:3000')
	.split(',')
	.map((o) => o.trim())
	.filter(Boolean);

function resolveOrigin(requestOrigin: string | null): string {
	if (!requestOrigin) return ALLOWED_ORIGINS[0]!;
	return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0]!;
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
export function publicCorsHeaders(
	methods: string = 'GET, POST, OPTIONS'
): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': methods,
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': '86400',
	};
}
