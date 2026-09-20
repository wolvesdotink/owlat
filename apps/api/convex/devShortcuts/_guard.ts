/**
 * Dev-deployment guard shared by every endpoint and mutation that should only
 * be reachable during local development.
 *
 * **Fail-closed.** Default behavior is "this is production" unless the operator
 * explicitly opts in by setting `OWLAT_DEV_MODE` to a truthy value in the
 * Convex backend's runtime env. CLI-side env vars like `CONVEX_DEPLOYMENT`
 * (which lives in `apps/api/.env.local` for the `convex` CLI) are NOT
 * propagated into the function runtime by self-host docker templates, so they
 * can't be used as a security boundary.
 *
 * To enable dev shortcuts on local / selfhost:
 *   `npx convex env set OWLAT_DEV_MODE true`
 * Production deployments leave it unset.
 *
 * Used by:
 *   - apps/api/convex/seedDemo/indexHttp.ts   (POST /seed/demo)
 *   - apps/api/convex/devShortcuts/resetHttp.ts (POST /dev/reset)
 *   - apps/api/convex/devShortcuts/forceVerifyDomain.ts
 *   - apps/api/convex/auth/auth.ts            (disables BetterAuth rate limiting on dev)
 *   - apps/api/convex/auth/trustedOrigins.ts  (keeps the loopback origin defaults on dev)
 */

import { getBoolean } from '../lib/env';

export function isDevDeployment(): boolean {
	return getBoolean('OWLAT_DEV_MODE');
}

/**
 * Throw if the current deployment has not opted in to dev shortcuts. Mutations
 * and queries call this; HTTP actions call `devDeploymentResponseOrNull()` and
 * forward the response to the client.
 */
export function assertDevDeployment(): void {
	if (!isDevDeployment()) {
		throw new Error('Dev-only endpoint refused: OWLAT_DEV_MODE is not enabled on this deployment.');
	}
}

/**
 * HTTP-action variant. Returns a 403 `Response` if dev mode is not enabled, or
 * `null` to indicate the caller should proceed.
 */
export function devDeploymentResponseOrNull(): Response | null {
	if (isDevDeployment()) return null;
	// The shared `lib/httpResponse.ts:errorResponse` would be the natural call,
	// but importing it here closes a cycle — `lib/cors.ts` imports
	// `isDevDeployment` from this module and `httpResponse.ts` imports
	// `publicCorsHeaders` from `cors.ts`. The envelope is two fields; the cycle
	// would run through the one module that throws on an unconfigured
	// deployment.
	return new Response(
		JSON.stringify({
			error: {
				category: 'forbidden',
				message: 'Dev-only endpoint refused: OWLAT_DEV_MODE is not enabled',
			},
		}),
		{ status: 403, headers: { 'Content-Type': 'application/json' } }
	);
}
