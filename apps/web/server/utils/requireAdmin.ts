import { ConvexHttpClient } from 'convex/browser';
import { api } from '@owlat/api';
import type { H3Event } from 'h3';

/**
 * Validate that the incoming request is authenticated AND its user is a
 * platform admin. Throws 401 if unauthenticated, 403 if not admin, or 503
 * if Convex is unreachable.
 *
 * Pattern:
 *   1. Exchange the better-auth session cookie for a Convex JWT via the
 *      internal /api/auth/convex/token proxy (which forwards cookies to
 *      Convex).
 *   2. Create a ConvexHttpClient and set the JWT as auth.
 *   3. Call api.platformAdmin.isPlatformAdmin.
 *
 * Used by system & internal routes that must only be reachable by platform
 * admins in a session context (not the X-Instance-Secret pattern).
 */
export async function requirePlatformAdmin(event: H3Event): Promise<ConvexHttpClient> {
	const config = useRuntimeConfig();
	const convexUrl = config.public.convexUrl as string;

	if (!convexUrl) {
		throw createError({
			statusCode: 503,
			message: 'Convex not configured',
		});
	}

	// 1. Exchange the session cookie for a Convex JWT.
	const cookieHeader = getHeader(event, 'cookie');
	if (!cookieHeader) {
		throw createError({ statusCode: 401, message: 'Not authenticated' });
	}

	const host = getRequestHost(event);
	const proto = getRequestProtocol(event);
	const tokenResp = await fetch(`${proto}://${host}/api/auth/convex/token`, {
		method: 'GET',
		headers: { cookie: cookieHeader },
	});

	if (!tokenResp.ok) {
		throw createError({ statusCode: 401, message: 'Not authenticated' });
	}

	const { token } = (await tokenResp.json()) as { token?: string | null };
	if (!token) {
		throw createError({ statusCode: 401, message: 'No auth token' });
	}

	// 2. Create a Convex HTTP client with the JWT set as auth.
	const client = new ConvexHttpClient(convexUrl);
	client.setAuth(token);

	// 3. Verify platform-admin status.
	const isAdmin = await client.query(api.platformAdmin.platformAdmin.isPlatformAdmin, {});
	if (!isAdmin) {
		throw createError({ statusCode: 403, message: 'Platform admin access required' });
	}

	return client;
}
