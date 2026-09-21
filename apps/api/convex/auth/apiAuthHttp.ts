/**
 * The two unauthenticated shells of the public API surface: the CORS preflight
 * every browser client sends before a key-authed call, and the health probe.
 * Both are registered by `apiV1Http.ts`; the key-authed routes it wraps
 * validate through `internal.auth.apiAuth.*` in the sibling `auth/apiAuth.ts`.
 */
import { httpAction } from '../_generated/server';
import { corsHeaders as sharedCorsHeaders } from '../lib/cors';
import { jsonResponse, publicCorsHeaders } from '../lib/httpResponse';

/**
 * Handle CORS preflight requests
 */
export const handleCors = httpAction(async (_ctx, request) => {
	const origin = request.headers.get('Origin');
	return new Response(null, {
		status: 204,
		headers: {
			...sharedCorsHeaders(undefined, origin),
			'Access-Control-Max-Age': '86400',
		},
	});
});

/**
 * API health check endpoint.
 *
 * Deliberately NOT on the credentialed `corsHeaders()` path the key-authed
 * routes use: that helper resolves an allow-list and throws when
 * ALLOWED_ORIGINS/SITE_URL/ADMIN_SITE_URL are all unset, which would turn a
 * readiness probe on a half-configured deployment into a 500 — exactly the
 * moment the setup CLI polls it. An unauthenticated liveness answer carries no
 * credentials, so `'*'` is the honest allow-origin.
 *
 * Handles its own `OPTIONS` preflight (the sibling public token endpoints do
 * the same) so the route is not GET-only.
 */
export const healthCheck = httpAction(async (_ctx, request) => {
	const headers = publicCorsHeaders('GET, OPTIONS');
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers });
	}
	return jsonResponse(
		{
			data: {
				status: 'ok',
				timestamp: new Date().toISOString(),
			},
		},
		200,
		headers
	);
});
