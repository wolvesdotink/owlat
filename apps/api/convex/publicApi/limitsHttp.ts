/**
 * GET /api/v1/limits — the transactional send limits that apply to the asking
 * key, and what is left of its daily one (`transactional/sendLimits.ts`).
 *
 * Any key may read its own: the caps are the instance's, the count is the
 * key's own, and neither names a recipient. The read charges no limit beyond
 * the request itself.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { createAuthenticatedHandler, type AuthenticatedContext } from '../auth/apiHandlers';
import { jsonResponse } from '../auth/apiResponses';

export const getLimits = createAuthenticatedHandler(
	async (ctx: ActionCtx, _request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const limits = await ctx.runQuery(internal.transactional.sendLimits.forApiKey, {
			keyId: auth.keyId,
			now: Date.now(),
		});
		return jsonResponse({ data: limits });
	}
);
