import { ConvexHttpClient } from 'convex/browser';
import type { H3Event } from 'h3';

/**
 * Exchange the better-auth session cookie for a Convex JWT and return an
 * authenticated `ConvexHttpClient`. This proves AUTHENTICATION only — the admin
 * PROBE is each gate's own job, so `requirePlatformAdmin` and `requireOrgAdmin`
 * share this preamble and differ only in the authorization query they run.
 *
 * Throws 503 when Convex isn't configured, 401 when the request carries no
 * usable session.
 *
 * Pattern:
 *   1. Exchange the session cookie for a Convex JWT via the internal
 *      `/api/auth/convex/token` proxy (which forwards cookies to Convex).
 *   2. Create a `ConvexHttpClient` and set the JWT as auth.
 */
export async function authedConvexClient(event: H3Event): Promise<ConvexHttpClient> {
	const config = useRuntimeConfig();
	const convexUrl = config.public.convexUrl as string;
	if (!convexUrl) {
		throw createError({ statusCode: 503, message: 'Convex not configured' });
	}

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

	const client = new ConvexHttpClient(convexUrl);
	client.setAuth(token);
	return client;
}
