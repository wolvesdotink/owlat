import { api } from '@owlat/api';
import type { ConvexHttpClient } from 'convex/browser';
import type { H3Event } from 'h3';
import { authedConvexClient, mapGateError } from './authedConvexClient';

/**
 * Validate that the incoming request is authenticated AND its user is an
 * ORGANIZATION owner or admin (the `organization:manage` floor), the gate that
 * guards the Settings → Delivery transport editor. Throws 401 if
 * unauthenticated, 403 if the user lacks the admin floor, or 503 if Convex is
 * unreachable (see `mapGateError`).
 *
 * Why `organization:manage` and not `requirePlatformAdmin`? Editing the
 * transport is an org-owner action: it is taken from the organization's own
 * settings by the people who administer that organization, so the floor is the
 * organization role, the same one every other org-admin surface enforces.
 *
 * The probe: the shared `authedConvexClient` exchanges the session cookie for a
 * Convex JWT, then this gate calls `auth.membership.assertOrganizationManage`, a
 * dedicated `adminQuery` that reads nothing. A non-admin gets a `forbidden`
 * Operation error, so a clean return IS the authorization proof, and the gate
 * no longer borrows the permission of an unrelated read model.
 */
export async function requireOrgAdmin(event: H3Event): Promise<ConvexHttpClient> {
	const client = await authedConvexClient(event);

	try {
		await client.query(api.auth.membership.assertOrganizationManage, {});
	} catch (e) {
		throw mapGateError(e, { forbiddenMessage: 'Delivery admin access required' });
	}

	return client;
}
