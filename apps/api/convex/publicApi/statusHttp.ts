/**
 * GET /api/v1/status — whether this instance can send, and if not, why and
 * what fixes it.
 *
 * It needs `status:read`, a scope of its own, so a key minted only to send or
 * to manage contacts learns nothing new. What it returns every member of the
 * workspace already reads in the web app (`delivery/healthReport.ts`). The
 * read is a handful of bounded queries on small tables, so a poller goes
 * through the per-key rate limit like any other call and nothing is cached.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import {
	createAuthenticatedHandler,
	requireScope,
	type AuthenticatedContext,
} from '../auth/apiHandlers';
import { jsonResponse } from '../auth/apiResponses';

export const getStatus = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'status:read', request.headers.get('Origin'));
		if (denied) return denied;
		const status = await ctx.runQuery(internal.publicApi.status.getForApi, {});
		return jsonResponse({ data: status });
	}
);
