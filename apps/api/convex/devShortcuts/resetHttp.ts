/**
 * `POST /dev/reset` — wipe the instance back to a blank slate so the signup
 * flow at `/auth/register` can be exercised end-to-end without
 * `docker compose down -v`.
 *
 * Protected by:
 *   - `assertDevDeployment()` — refuses unless `OWLAT_DEV_MODE` is enabled
 *   - `requireInstanceSecret` — per-IP throttle, then the X-Instance-Secret
 *     header (timing-safe compare)
 *
 * The wipe itself is `internal.devShortcuts.reset.runReset` in the sibling
 * `devShortcuts/reset.ts`.
 */

import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { requireInstanceSecret } from '../lib/instanceSecret';
import { logError } from '../lib/runtimeLog';
import { devDeploymentResponseOrNull } from './_guard';
import { errorResponse, jsonResponse } from '../lib/httpResponse';

export const resetHttp = httpAction(async (ctx, request) => {
	const devResp = devDeploymentResponseOrNull();
	if (devResp) return devResp;

	const denied = await requireInstanceSecret(ctx, request, { limitType: 'instanceSecret' });
	if (denied) return denied;

	try {
		const counts = await ctx.runMutation(internal.devShortcuts.reset.runReset, {});
		return jsonResponse({ deleted: counts });
	} catch (error) {
		// Locked error envelope — log the real cause server-side, return a fixed message.
		logError('[devReset] reset failed:', error);
		return errorResponse('internal', 'Internal error');
	}
});
