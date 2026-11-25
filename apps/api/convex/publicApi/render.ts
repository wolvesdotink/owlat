/**
 * What the API's renders read and spend: `POST /api/v1/render`
 * (`renderHttp.ts`) and the dry run of `POST /api/v1/transactional`
 * (`transactional/dryRunAnswer.ts`). Neither stores anything; each spends one
 * token of the key's `apiRender` bucket, apart from template writes and the
 * send caps.
 */

import { v } from 'convex/values';
import type { EmailTheme } from '@owlat/shared';
import { internalQuery } from '../_generated/server';
import { errorResponse, type RateLimitHeaders } from '../auth/apiResponses';
import { isFeatureEnabled } from '../lib/featureFlags';
import { loadEmailTheme } from '../lib/publishableEmailRender';
import { rateLimiter } from '../lib/rateLimiter';
import { internalMutation } from '../lib/writeFence';

/** Spend one of the key's render tokens, or say how long to wait. */
export const spendRenderToken = internalMutation({
	args: { keyId: v.id('apiKeys') },
	handler: async (ctx, args): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> => {
		const { ok, retryAfter } = await rateLimiter.limit(ctx, 'apiRender', { key: args.keyId });
		if (ok) return { ok: true };
		return { ok: false, retryAfterSeconds: Math.ceil((retryAfter ?? 1000) / 1000) };
	},
});

/** The instance settings a render reads: the email theme every stored render uses. */
export const renderSettings = internalQuery({
	args: {},
	handler: async (ctx): Promise<{ theme: EmailTheme | null; transactionalEnabled: boolean }> => ({
		theme: (await loadEmailTheme(ctx)) ?? null,
		transactionalEnabled: await isFeatureEnabled(ctx, 'transactional'),
	}),
});

export function renderRateLimitedResponse(
	retryAfterSeconds: number,
	rateLimit: RateLimitHeaders
): Response {
	return errorResponse(
		'rate_limited',
		'Too many renders from this API key. Retry after the Retry-After header.',
		{ data: { reason: 'render_rate_limited' }, retryAfter: retryAfterSeconds, rateLimit }
	);
}
