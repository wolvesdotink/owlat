/**
 * POST /api/v1/domains/{domain}/verify — ask for a fresh check of one sending
 * domain's DNS records (`./domainCheck.ts`).
 *
 * It answers `202` once the check is queued, and the caller reads the result
 * from `GET /api/v1/domains`. The check is a series of live DNS lookups, one
 * per record and each bounded only by the resolver's own timeout, so run
 * inside the request it could outlast the HTTP action's time budget on a slow
 * nameserver and leave the caller with an error for a check that may still
 * land.
 *
 * It needs `domains:verify`, not `status:read`: the check rewrites the
 * domain's stored verification state, and can move a verified domain towards
 * failed, so a key that only reads the status cannot cause it. Keys minted
 * before the scope existed do not carry it.
 *
 * Any domain the path does not name (unknown, malformed, another table's ID, a
 * tracking domain) answers the same 404.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import {
	createAuthenticatedHandler,
	requireScope,
	type AuthenticatedContext,
} from '../auth/apiHandlers';
import { errorResponse, errorResponseFromThrow, jsonResponse } from '../auth/apiResponses';
import { safeDecodeURIComponent } from '../lib/inputGuards';
import type { DomainCheckOutcome } from './domainCheck';

const NOT_FOUND = 'Domain not found';

/** `{domain}` of `/api/v1/domains/{domain}/verify`, or null for any other path. */
function domainFromPath(request: Request): { ok: true; value: string } | { ok: false } | null {
	const parts = new URL(request.url).pathname.split('/');
	// ['', 'api', 'v1', 'domains', '{domain}', 'verify']
	if (parts.length !== 6 || parts[5] !== 'verify' || !parts[4]) return null;
	const value = safeDecodeURIComponent(parts[4]);
	return value === null ? { ok: false } : { ok: true, value };
}

export const verifyDomain = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'domains:verify', request.headers.get('Origin'));
		if (denied) return denied;
		const domain = domainFromPath(request);
		if (domain === null) return errorResponse('not_found', 'Not found');
		// An undecodable segment names no domain either: the same 404.
		if (!domain.ok) return errorResponse('not_found', NOT_FOUND);

		let outcome: DomainCheckOutcome;
		try {
			outcome = await ctx.runMutation(internal.publicApi.domainCheck.requestForApi, {
				domain: domain.value,
			});
		} catch (error) {
			// A request the deletion fence refused keeps its own 422.
			return errorResponseFromThrow(error, 'Failed to request a domain check');
		}
		switch (outcome.kind) {
			case 'not_found':
				return errorResponse('not_found', NOT_FOUND);
			case 'registering':
				return errorResponse(
					'conflict',
					'This domain is still being registered and has no records to check yet. Try again once GET /api/v1/domains lists its records.',
					{ data: { reason: 'domain_registering' } }
				);
			case 'rate_limited':
				return errorResponse(
					'rate_limited',
					'This domain was checked less than a minute ago. Wait for the Retry-After interval before asking again.',
					{
						data: { reason: 'domain_check_rate_limited' },
						retryAfter: Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)),
					}
				);
			case 'queued':
				return jsonResponse({ data: outcome.request }, 202);
		}
	}
);
