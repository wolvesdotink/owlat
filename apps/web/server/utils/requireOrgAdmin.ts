import { api } from '@owlat/api';
import { extractOperationError } from '@owlat/shared/operationError';
import type { ConvexHttpClient } from 'convex/browser';
import type { H3Event } from 'h3';
import { authedConvexClient } from './authedConvexClient';

/**
 * Validate that the incoming request is authenticated AND its user is an
 * ORGANIZATION admin (the `organization:manage` floor) — the gate that guards
 * the Settings → Delivery surface. Throws 401 if unauthenticated, 403 if the
 * user lacks the admin floor, or 503 if Convex is unreachable.
 *
 * Why not `requirePlatformAdmin`? Platform-admin is INERT on an OSS self-host
 * deployment (no production path seeds the `platformAdmins` table — see
 * `convex/platformAdmin/platformAdmin.ts`), so gating an operator action on it
 * would lock every self-hoster out. The transport editor is a deployment-wide
 * change an org owner/admin makes, so the correct floor is `organization:manage`
 * — exactly what the read-only status query already enforces.
 *
 * The probe: the shared `authedConvexClient` exchanges the session cookie for a
 * Convex JWT, then this gate calls the admin-gated `delivery.status.getStatus`.
 * A non-admin throws a `forbidden` Operation error, so a clean call IS the
 * authorization proof — no separate assert query — and the status query returns
 * only presence booleans (never a credential).
 */
export async function requireOrgAdmin(event: H3Event): Promise<ConvexHttpClient> {
	const client = await authedConvexClient(event);

	// The admin-gated status query throws for a non-admin; a clean return is the
	// `organization:manage` proof. Never surface its payload — only its success.
	try {
		await client.query(api.delivery.status.getStatus, {});
	} catch (e) {
		// Only a real authorization denial is a 403/401 — narrow on the Operation
		// error category so an outage (Convex unreachable, timeout) surfaces
		// honestly as 503 instead of being misreported as "access required".
		const op = extractOperationError(e);
		if (op?.category === 'forbidden') {
			throw createError({ statusCode: 403, message: 'Delivery admin access required' });
		}
		if (op?.category === 'unauthenticated') {
			throw createError({ statusCode: 401, message: 'Not authenticated' });
		}
		throw createError({
			statusCode: 503,
			message: 'Could not verify delivery admin access — the backend is unreachable.',
		});
	}

	return client;
}
