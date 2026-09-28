import { api } from '@owlat/api';
import type { ConvexHttpClient } from 'convex/browser';
import type { H3Event } from 'h3';
import { authedConvexClient, mapGateError } from './authedConvexClient';

/**
 * Validate that the incoming request is authenticated AND its user is a
 * platform admin. Throws 401 if unauthenticated, 403 if not admin, or 503
 * if Convex is unreachable.
 *
 * The authenticated Convex client is built by the shared `authedConvexClient`;
 * this gate adds only the platform-admin probe, and maps a failed probe through
 * the shared `mapGateError`, so an outage answers 503 here exactly as it does on
 * `requireOrgAdmin` instead of escaping as an unmapped 500.
 *
 * Used by system & internal routes that must only be reachable by platform
 * admins in a session context (not the X-Instance-Secret pattern).
 *
 * Note on the `server/api/internal/*` prefix: those are ordinary, externally
 * reachable Nitro routes. The `internal/` path segment is naming only — it does
 * NOT restrict them to the loopback interface or a private network. They are
 * protected solely by their `X-Instance-Secret` / session guards, so operators
 * should firewall them at the reverse proxy where their threat model requires
 * it. This helper is the session guard used by that family of routes.
 */
export async function requirePlatformAdmin(event: H3Event): Promise<ConvexHttpClient> {
	const client = await authedConvexClient(event);

	const forbiddenMessage = 'Platform admin access required';
	let isAdmin: boolean;
	try {
		isAdmin = await client.query(api.platformAdmin.platformAdmin.isPlatformAdmin, {});
	} catch (e) {
		throw mapGateError(e, { forbiddenMessage });
	}
	if (!isAdmin) {
		throw createError({ statusCode: 403, message: forbiddenMessage });
	}

	return client;
}
