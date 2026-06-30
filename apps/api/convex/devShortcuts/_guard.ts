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
 *   - apps/api/convex/seedDemo/index.ts       (POST /seed/demo)
 *   - apps/api/convex/devShortcuts/reset.ts   (POST /dev/reset)
 *   - apps/api/convex/devShortcuts/forceVerifyDomain.ts
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
		throw new Error(
			'Dev-only endpoint refused: OWLAT_DEV_MODE is not enabled on this deployment.',
		);
	}
}

/**
 * HTTP-action variant. Returns a 403 `Response` if dev mode is not enabled, or
 * `null` to indicate the caller should proceed.
 */
export function devDeploymentResponseOrNull(): Response | null {
	if (isDevDeployment()) return null;
	return new Response(
		JSON.stringify({
			error: 'Dev-only endpoint refused: OWLAT_DEV_MODE is not enabled',
		}),
		{ status: 403, headers: { 'Content-Type': 'application/json' } },
	);
}
