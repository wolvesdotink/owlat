/**
 * Gate for the decision plane. Lives outside the `'use node'` dispatch (which
 * can't hold mutations) so a decision action can `runMutation` it before it
 * spends a call: it enforces the `ai.decisionPlane` feature flag and the
 * instance-global rate limit, mirroring `mail/ai/gate.ts` — deliberately, so a
 * caller's existing fail-soft catch behaves identically whichever plane it is
 * gating. A Convex action has no `ctx.db`, so it cannot read a feature flag at
 * all; that is the whole reason this mutation exists rather than an `if` in the
 * dispatch.
 *
 * The flag is the KILL SWITCH. The decision plane is the only path in the
 * product that sends message content to a provider the operator chose for
 * decisions rather than for writing, so stopping it must be one click in
 * Settings → Features — not an env edit and a redeploy. It defaults OFF and
 * `requires: ['ai']`, so the master AI toggle stops it too and an install that
 * never opted in resolves exactly as it does today.
 *
 * The answer it returns is not advisory: `lib/decision/dispatch.runDecision`
 * takes it as a required argument, so the only way to reach the plane is
 * through here. See {@link DecisionAllowance}.
 *
 * What this gate deliberately does NOT do is block on the breaker. The breaker
 * guards the expensive FALLBACK HOP, not the decision itself — a cheap call to
 * a struggling provider is still the right call to make — so the gate reports
 * the breaker's verdict back to the caller and lets the dispatch decide.
 */

import { internalMutation } from '../_generated/server';
import { isFeatureEnabled } from '../lib/featureFlags';
import { rateLimiter } from '../rateLimiter';
import { throwForbidden, throwRateLimited } from '../_utils/errors';
import type { DecisionAllowance } from '../lib/decisionProviders/types';
import { readDecisionBreaker, type DecisionBreakerState } from './breaker';

/** What the gate hands back, plus the breaker's state for a surface to render. */
export interface DecisionGateResult extends DecisionAllowance {
	readonly breakerState: DecisionBreakerState;
}

export const assertDecisionAllowed = internalMutation({
	args: {},
	handler: async (ctx): Promise<DecisionGateResult> => {
		// One check covers two flags: `resolveFlags` forces `ai.decisionPlane` off
		// whenever the master `ai` flag is off, because it declares the dependency.
		if (!(await isFeatureEnabled(ctx, 'ai.decisionPlane'))) {
			throwForbidden('The decision plane is disabled');
		}

		// Instance-global, unkeyed: one upstream account, one shared quota.
		const res = await rateLimiter.limit(ctx, 'decisionPlaneGlobal');
		if (!res.ok) {
			throwRateLimited('The decision plane is busy — try again in a moment.', res.retryAfter);
		}

		// Read, don't charge: the dispatch asks the breaker again only if a
		// failure actually makes it consider the hop, and this saves that round
		// trip on the happy path.
		const breaker = await readDecisionBreaker(ctx);
		// `allowed` is not decoration. `runDecision` REQUIRES this object, and this
		// mutation is the only thing that builds one, so a call site cannot reach
		// the vendor without the flag and the bucket having been read first — the
		// kill switch is in the type, not in a convention.
		return { allowed: true, fallbackAllowed: breaker.fallbackAllowed, breakerState: breaker.state };
	},
});
