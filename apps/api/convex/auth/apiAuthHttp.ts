/**
 * The two unauthenticated shells of the public API surface: the CORS preflight
 * every browser client sends before a key-authed call, and the health probe.
 * Both are registered by `apiV1Http.ts`; the key-authed routes it wraps
 * validate through `internal.auth.apiAuth.*` in the sibling `auth/apiAuth.ts`.
 */
import { httpAction } from '../_generated/server';
import { corsHeaders as sharedCorsHeaders } from '../lib/cors';
import { jsonResponse } from './apiResponses';

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
 * API health check endpoint
 */
export const healthCheck = httpAction(async () => {
	return jsonResponse({
		status: 'ok',
		timestamp: new Date().toISOString(),
	});
});
