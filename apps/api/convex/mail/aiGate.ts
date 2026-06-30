/**
 * Gate for the user-triggered Postbox AI actions. Lives outside the 'use node'
 * mail/ai.ts (which can't hold mutations) so the action can runMutation it
 * before spending an LLM call: it enforces the `ai` feature flag and a
 * per-user rate limit, mirroring the inbound pipeline's gating.
 */
import { internalMutation } from '../_generated/server';
import { isFeatureEnabled } from '../lib/featureFlags';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { rateLimiter } from '../rateLimiter';
import { throwForbidden, throwRateLimited } from '../_utils/errors';

export const assertAiAllowed = internalMutation({
	args: {},
	handler: async (ctx) => {
		if (!(await isFeatureEnabled(ctx, 'ai'))) {
			throwForbidden('AI features are disabled');
		}
		const session = await getBetterAuthSessionWithRole(ctx);
		const key = session?.userId ?? 'anon';
		const res = await rateLimiter.limit(ctx, 'postboxAiPerUser', { key });
		if (!res.ok) {
			throwRateLimited('AI is busy — try again in a moment.', res.retryAfter);
		}
	},
});
