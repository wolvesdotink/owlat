/**
 * `POST /dev/reset` — wipe the instance back to a blank slate so the signup
 * flow at `/auth/register` can be exercised end-to-end without
 * `docker compose down -v`.
 *
 * Protected by:
 *   - X-Instance-Secret header (timing-safe compare)
 *   - `assertDevDeployment()` — refuses unless `OWLAT_DEV_MODE` is enabled
 *
 * The wipe itself is `internal.devShortcuts.reset.runReset` in the sibling
 * `devShortcuts/reset.ts`.
 */

import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { safeCompare } from '../lib/safeCompare';
import { logError } from '../lib/runtimeLog';
import { devDeploymentResponseOrNull } from './_guard';
import { errorResponse, jsonResponse } from '../lib/httpResponse';

export const resetHttp = httpAction(async (ctx, request) => {
	const devResp = devDeploymentResponseOrNull();
	if (devResp) return devResp;

	const secret = request.headers.get('X-Instance-Secret');
	const expected = getOptional('INSTANCE_SECRET');
	if (!expected || !secret || !safeCompare(secret, expected)) {
		return errorResponse('unauthenticated', 'Unauthorized');
	}

	try {
		const counts = await ctx.runMutation(internal.devShortcuts.reset.runReset, {});
		return jsonResponse({ deleted: counts });
	} catch (error) {
		// Locked error envelope — log the real cause server-side, return a fixed message.
		logError('[devReset] reset failed:', error);
		return errorResponse('internal', 'Internal error');
	}
});
