import { api } from '@owlat/api';
import type { ConvexHttpClient } from 'convex/browser';
import type { H3Event } from 'h3';
import { authedConvexClient } from './authedConvexClient';

/**
 * Validate that the incoming request is authenticated AND its user is a
 * platform admin. Throws 401 if unauthenticated, 403 if not admin, or 503
 * if Convex is unreachable.
 *
 * The authenticated Convex client is built by the shared `authedConvexClient`;
 * this gate adds only the platform-admin probe.
 *
 * Used by system & internal routes that must only be reachable by platform
 * admins in a session context (not the X-Instance-Secret pattern).
 */
export async function requirePlatformAdmin(event: H3Event): Promise<ConvexHttpClient> {
	const client = await authedConvexClient(event);

	const isAdmin = await client.query(api.platformAdmin.platformAdmin.isPlatformAdmin, {});
	if (!isAdmin) {
		throw createError({ statusCode: 403, message: 'Platform admin access required' });
	}

	return client;
}
