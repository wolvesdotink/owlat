import { ConvexHttpClient } from 'convex/browser';
import { api } from '@owlat/api';
import type { H3Event } from 'h3';

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
 * The probe: exchange the better-auth session cookie for a Convex JWT, then call
 * the admin-gated `delivery.status.getStatus`. It throws for a non-admin, so a
 * successful call IS the authorization proof — no separate assert query needed,
 * and the status query returns only presence booleans (never a credential).
 */
export async function requireOrgAdmin(event: H3Event): Promise<ConvexHttpClient> {
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

	// The admin-gated status query throws for a non-admin; a clean return is the
	// `organization:manage` proof. Never surface its payload — only its success.
	try {
		await client.query(api.delivery.status.getStatus, {});
	} catch {
		throw createError({ statusCode: 403, message: 'Delivery admin access required' });
	}

	return client;
}
