/**
 * GET /api/v1/domains — each sending domain with its verification state and
 * every DNS record it needs: the name, the value to publish and what the last
 * check found.
 *
 * It needs `status:read`, the scope of `GET /api/v1/status`: the status names
 * each domain's verification state and this route says what is left to
 * publish, both facts every member reads in the web app, and the records are
 * public DNS values. A key minted only to send or to manage contacts learns
 * nothing new.
 *
 * Read-only: it reports the last check, and `lastCheckedAt` says when that
 * was. The daily sweep (`domains/reverificationSweep.ts`) re-checks only
 * domains that were verified once; one still being set up is re-checked while
 * the Domains page is open. The on-demand check behind that page
 * (`domains/dnsVerification.ts:verifyDomain`) runs live DNS lookups with no
 * rate limit of its own, so a key cannot trigger it here.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import {
	createAuthenticatedHandler,
	requireScope,
	type AuthenticatedContext,
} from '../auth/apiHandlers';
import { jsonResponse } from '../auth/apiResponses';

export const listDomains = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'status:read', request.headers.get('Origin'));
		if (denied) return denied;
		const domains = await ctx.runQuery(internal.publicApi.domains.listForApi, {});
		return jsonResponse({ data: domains });
	}
);
