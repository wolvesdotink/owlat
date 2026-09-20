/**
 * Decision plane — the circuit breaker that guards the FALLBACK HOP.
 *
 * `lib/decision/dispatch.ts` may hop once onto the language plane when the
 * decision provider fails in a fallback-eligible way. That hop is a cost lever
 * an outsider can pull: the path is fed by strangers sending us email, and the
 * model it re-routes onto costs 24 to 50 times more per call. Anything that
 * breaks the decision plane — an expired key, a 429, a vendor outage — would
 * otherwise re-route EVERY inbound message onto the expensive model for as long
 * as the outage lasts. `analytics/spendBudget.ts` exists because of that exact
 * threat; this breaker is the same argument applied one layer earlier, so the
 * ceiling never has to absorb the amplification in the first place.
 *
 * The vocabulary is the `llm_failure` breaker's in `agentHealth.ts` — `closed`,
 * `open`, `half_open`, a current value against a threshold, and hysteresis
 * between tripping and recovering — because a second breaker with a second
 * vocabulary is how an operator ends up reading two words for one state.
 *
 * WHERE THE STATE LIVES. A failure budget over a rolling window IS a token
 * bucket, so the breaker is one: `decisionPlaneFailure` in `rateLimiter.ts`.
 * The component already gives us atomic, persistent, contention-safe accounting
 * with time-based refill, which is precisely the recovery curve a breaker
 * wants. It also keeps the guarantee legible: a failure cannot produce a hop
 * without first spending a token, so the hop is bounded by the bucket's refill
 * rate BY CONSTRUCTION — not by a threshold someone has to get right.
 * `agentCircuitBreakers` is deliberately not reused: it is the agent pipeline's
 * rollup-driven breaker (a cron writes it every window, `breakerType` is a
 * closed union) and this one is written on the request path.
 *
 * THE STATES, and why `half_open` also refuses the hop:
 *
 *   closed     Half the budget or more is available. The hop is allowed.
 *   half_open  Some budget is back, but less than half. The hop STAYS OFF.
 *   open       The budget is exhausted. The hop is off.
 *
 * `half_open` is hysteresis, not permission: the breaker trips when the budget
 * runs out and closes only once half of it has returned, so a provider that
 * fails, works for ten seconds and fails again cannot re-open the expensive
 * path on every flap.
 *
 * THE REFILL IS THE ONLY WAY BACK, deliberately. An earlier draft had a
 * shortcut — a success after a quiet stretch closed the breaker early, the
 * classic half-open probe — and it was wrong in the one case it mattered: the
 * component writes NOTHING when a charge is refused, so once the budget is
 * spent the bucket's timestamp freezes and "quiet" starts accruing in the
 * middle of the outage. A provider flapping through a 429 storm would have
 * re-armed the whole budget every thirty seconds, which is the opposite of what
 * a breaker is for. A rate that is only ever observed through the charges it
 * ACCEPTS cannot answer "when did we last see a failure", so the breaker does
 * not ask: the bucket's refill is the recovery curve, and it runs on the clock
 * whether or not anything succeeds.
 *
 * WIRING. This is the ctx-bound half of the `DecisionFallbackBreaker` port
 * `lib/decision/contract.ts` declares; the dispatch itself stays injectable and
 * ctx-free. `lib/decision/ports.ts` builds the port from these two functions.
 */

import { calculateRateLimit } from '@convex-dev/rate-limiter';
import { internalMutation, internalQuery } from '../_generated/server';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { rateLimiter } from '../rateLimiter';

/**
 * Fraction of the failure budget that must be back before the hop is allowed
 * again. The trip point is "no budget left" and the close point is this, which
 * is the whole of the hysteresis: one number to open, a different one to close.
 */
export const DECISION_BREAKER_CLOSE_FRACTION = 0.5;

/** Same three words the `agentCircuitBreakers` rows use. */
export type DecisionBreakerState = 'closed' | 'open' | 'half_open';

export interface DecisionBreakerStatus {
	readonly state: DecisionBreakerState;
	/** Failures charged against the budget right now — `currentValue` in the agent breaker's terms. */
	readonly failures: number;
	/** The budget a window holds — `threshold` in the agent breaker's terms. */
	readonly budget: number;
	/** The one question the dispatch asks: may it spend the expensive hop? */
	readonly fallbackAllowed: boolean;
}

/**
 * The state machine, as a pure function of "budget left" so it can be reasoned
 * about (and tested) without a database. `remaining` is fractional — the bucket
 * refills continuously — so the open test is "not even one whole failure left
 * to charge", which is exactly the point at which a further failure could no
 * longer be metered.
 */
export function decisionBreakerStateFor(remaining: number, budget: number): DecisionBreakerState {
	if (budget <= 0) return 'open';
	if (remaining < 1) return 'open';
	if (remaining < budget * DECISION_BREAKER_CLOSE_FRACTION) return 'half_open';
	return 'closed';
}

function statusFrom(remaining: number, budget: number): DecisionBreakerStatus {
	const state = decisionBreakerStateFor(remaining, budget);
	return {
		state,
		failures: Math.max(0, Math.round(budget - remaining)),
		budget,
		fallbackAllowed: state === 'closed',
	};
}

/**
 * Read the breaker without charging anything. Exported as a helper rather than
 * only as a query because `decision/gate.ts` runs in the same mutation and a
 * nested `runQuery` for one budget reading would be a round trip for nothing.
 */
export async function readDecisionBreaker(
	ctx: QueryCtx | MutationCtx
): Promise<DecisionBreakerStatus> {
	const { value, ts, config } = await rateLimiter.getValue(ctx, 'decisionPlaneFailure');
	// The component deliberately reports the budget AS OF the last write ("so the
	// query isn't too time-aware"), which for a breaker is the one thing we can't
	// use: recovery IS the passage of time. Roll it forward with the component's
	// own arithmetic, consuming nothing.
	const now = Date.now();
	const remaining = calculateRateLimit({ value, ts }, config, now).value;
	// The bucket's own config is the single source of the budget — repeating the
	// capacity here would let the two drift apart silently.
	const budget = config.capacity ?? config.rate;
	return statusFrom(remaining, budget);
}

/**
 * A decision-plane failure. Charges one token; when the budget is gone the
 * charge simply fails and the breaker reads `open` — a breaker that threw on
 * the way to reporting a failure would turn an outage into a second outage.
 *
 * Only the PRIMARY plane's failures belong here. The hop's own failures are the
 * language plane's signal, and charging them would let one outage trip two
 * breakers.
 */
export const recordFailure = internalMutation({
	args: {},
	handler: async (ctx) => {
		await rateLimiter.limit(ctx, 'decisionPlaneFailure');
		return await readDecisionBreaker(ctx);
	},
});

/**
 * The breaker as the dispatch's port reads it, and as the settings card
 * renders it in words ("the decision plane has been failing, so the fallback is
 * off"). A query, so the admin surface can subscribe to it.
 */
export const status = internalQuery({
	args: {},
	handler: async (ctx) => await readDecisionBreaker(ctx),
});
