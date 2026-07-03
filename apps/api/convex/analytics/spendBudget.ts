/**
 * Per-org dollar-spend budget for LLM calls — a pre-call gate that FAILS CLOSED
 * when the org's daily/monthly budget is exhausted.
 *
 * Single-org-per-deployment (see `lib/sessionOrganization.ts`), so "per-org"
 * here is the deployment-wide `llmUsageEvents` ledger already written by every
 * priced LLM call (`analytics/llmUsage.ts`) and priced by `lib/llm/pricing.ts`.
 * Rate limits elsewhere are per-CALL-COUNT token buckets and `estimateCost`
 * only feeds a read-only dashboard, so nothing today caps DOLLARS — an org (or
 * a prompt-injected auto-reply loop) can run up unbounded spend. This module
 * turns that same aggregation into an enforced ceiling.
 *
 * Two consumers share one evaluation ({@link computeBudgetStatus}):
 *   - the AUTONOMOUS path (`agent/steps/route`) degrades to draft-only — the
 *     draft is still produced and queued for a human, only the unattended
 *     auto-SEND is withheld — so mail is never silently dropped and an injected
 *     loop can't keep auto-replying past the ceiling.
 *   - ADVISORY, user-triggered features (`mail/aiGate.ts`) degrade gracefully
 *     within a RESERVE: they are cut off once remaining headroom drops below the
 *     reserve fraction, preserving the tail of the budget for the critical
 *     drafting path rather than letting manual actions drain it to $0.
 *
 * Budgets are configured via env (see `lib/env.ts`); an unset / `0` limit means
 * "no limit for that period" and the gate is a no-op (today's behaviour).
 * Spend is a best-effort estimate over a bounded recent-events scan — the same
 * posture as the dashboard aggregation it reuses.
 */

import { internalQuery, type QueryCtx, type MutationCtx } from '../_generated/server';
import { adminQuery } from '../lib/authedFunctions';
import { getWithDefault } from '../lib/env';

/** Ceiling + guard fractions for the spend budget, resolved from env. */
export interface SpendBudgetConfig {
	/** Daily ceiling in USD. `0` ⇒ no daily limit. */
	dailyUsd: number;
	/** Monthly ceiling in USD. `0` ⇒ no monthly limit. */
	monthlyUsd: number;
	/** Fraction of a ceiling at which to start warning (0–1]. */
	warnFraction: number;
	/**
	 * Fraction of a ceiling reserved for the autonomous drafting path: advisory
	 * (user-triggered) features are blocked once remaining headroom drops to or
	 * below `limit * advisoryReserveFraction`. `0` ⇒ no reserve (advisory shares
	 * the full budget and is only blocked once the ceiling is hit).
	 */
	advisoryReserveFraction: number;
}

/** Parse a non-negative finite number, falling back on garbage/negative input. */
function parseNonNegative(raw: string, fallback: number): number {
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Resolve the budget config from env. Pure aside from the env read, so the
 * evaluation below stays unit-testable by constructing configs directly.
 */
export function resolveBudgetConfig(): SpendBudgetConfig {
	const dailyUsd = parseNonNegative(getWithDefault('AI_SPEND_DAILY_BUDGET_USD', '0'), 0);
	const monthlyUsd = parseNonNegative(getWithDefault('AI_SPEND_MONTHLY_BUDGET_USD', '0'), 0);

	let warnFraction = parseNonNegative(getWithDefault('AI_SPEND_WARN_FRACTION', '0.8'), 0.8);
	if (warnFraction <= 0 || warnFraction > 1) warnFraction = 0.8;

	let advisoryReserveFraction = parseNonNegative(
		getWithDefault('AI_SPEND_ADVISORY_RESERVE_FRACTION', '0.2'),
		0.2
	);
	if (advisoryReserveFraction < 0 || advisoryReserveFraction >= 1) advisoryReserveFraction = 0.2;

	return { dailyUsd, monthlyUsd, warnFraction, advisoryReserveFraction };
}

export type BudgetState = 'ok' | 'warn' | 'exceeded';

/** Budget picture for a single period (day or month). */
export interface PeriodBudget {
	/** Whether a ceiling is configured for this period. */
	configured: boolean;
	/** The ceiling in USD (`0` when unconfigured). */
	limitUsd: number;
	/** Estimated spend in the current period. */
	spentUsd: number;
	/** Remaining headroom in USD (`0` when unconfigured or over the ceiling). */
	remainingUsd: number;
	state: BudgetState;
	/** False when remaining headroom is within the advisory reserve or exhausted. */
	advisoryAllowed: boolean;
}

/** Combined budget status across both periods, shared by every consumer. */
export interface BudgetStatus {
	/** True when at least one period has a ceiling configured. */
	configured: boolean;
	daily: PeriodBudget;
	monthly: PeriodBudget;
	/** Worst state across the two periods. */
	state: BudgetState;
	/** False when EITHER period is over its ceiling — autonomous auto-send is withheld. */
	autonomousAutoSendAllowed: boolean;
	/** False when EITHER period is exceeded or within its advisory reserve. */
	advisoryAllowed: boolean;
	/** True at or above the warn threshold (but not yet blocking). */
	warn: boolean;
	/** Human-readable reason when a gate should block (empty when unconstrained). */
	reason: string;
}

/** Evaluate one period against its ceiling. Pure — the unit-tested core. */
export function evaluatePeriod(
	limitUsd: number,
	spentUsd: number,
	warnFraction: number,
	advisoryReserveFraction: number
): PeriodBudget {
	if (limitUsd <= 0) {
		return {
			configured: false,
			limitUsd: 0,
			spentUsd,
			remainingUsd: 0,
			state: 'ok',
			advisoryAllowed: true,
		};
	}
	const remainingUsd = Math.max(0, limitUsd - spentUsd);
	let state: BudgetState = 'ok';
	if (spentUsd >= limitUsd) state = 'exceeded';
	else if (spentUsd >= limitUsd * warnFraction) state = 'warn';
	// Advisory keeps a reserve for the autonomous drafting path: it is allowed
	// only while remaining headroom is strictly above the reserve floor.
	const advisoryAllowed = remainingUsd > limitUsd * advisoryReserveFraction;
	return { configured: true, limitUsd, spentUsd, remainingUsd, state, advisoryAllowed };
}

const WORST: Record<BudgetState, number> = { ok: 0, warn: 1, exceeded: 2 };

/** Combine per-period budgets + spend into the shared status object. Pure. */
export function evaluateBudget(
	config: SpendBudgetConfig,
	spentDailyUsd: number,
	spentMonthlyUsd: number
): BudgetStatus {
	const daily = evaluatePeriod(
		config.dailyUsd,
		spentDailyUsd,
		config.warnFraction,
		config.advisoryReserveFraction
	);
	const monthly = evaluatePeriod(
		config.monthlyUsd,
		spentMonthlyUsd,
		config.warnFraction,
		config.advisoryReserveFraction
	);

	const configured = daily.configured || monthly.configured;
	const state: BudgetState = WORST[daily.state] >= WORST[monthly.state] ? daily.state : monthly.state;
	const autonomousAutoSendAllowed = daily.state !== 'exceeded' && monthly.state !== 'exceeded';
	const advisoryAllowed = daily.advisoryAllowed && monthly.advisoryAllowed;
	const warn = state !== 'ok';

	let reason = '';
	if (!autonomousAutoSendAllowed) {
		const period = daily.state === 'exceeded' ? daily : monthly;
		const label = daily.state === 'exceeded' ? 'daily' : 'monthly';
		reason =
			`AI spend budget exhausted: ${label} ceiling $${period.limitUsd.toFixed(2)} reached ` +
			`($${period.spentUsd.toFixed(2)} spent). Auto-send withheld — routing to human review.`;
	} else if (!advisoryAllowed) {
		const period = !daily.advisoryAllowed ? daily : monthly;
		const label = !daily.advisoryAllowed ? 'daily' : 'monthly';
		reason =
			`AI spend budget low: only $${period.remainingUsd.toFixed(2)} of the ${label} ceiling ` +
			`$${period.limitUsd.toFixed(2)} remains, held in reserve for autonomous replies. ` +
			`Advisory AI is paused until the budget resets.`;
	}

	return {
		configured,
		daily,
		monthly,
		state,
		autonomousAutoSendAllowed,
		advisoryAllowed,
		warn,
		reason,
	};
}

/**
 * Estimated spend in the current UTC day and month from the `llmUsageEvents`
 * ledger. Bounded scan (same posture as `getSpendByFeature`): a best-effort
 * estimate, never billing. Over the cap the estimate under-reports, which only
 * delays the ceiling — it never blocks ingest.
 */
const MAX_EVENTS_SCANNED = 10_000;

async function spentInCurrentPeriods(
	ctx: QueryCtx | MutationCtx
): Promise<{ dailyUsd: number; monthlyUsd: number }> {
	const now = Date.now();
	const d = new Date(now);
	const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);

	const events = await ctx.db
		.query('llmUsageEvents')
		.withIndex('by_creation_time', (q) => q.gte('_creationTime', monthStart))
		.order('desc')
		.take(MAX_EVENTS_SCANNED);

	let dailyUsd = 0;
	let monthlyUsd = 0;
	for (const e of events) {
		// `createdAt` is the caller's wall clock; fall back to the system
		// `_creationTime` if an older row predates the field.
		const at = e.createdAt ?? e._creationTime;
		if (at < monthStart) continue;
		monthlyUsd += e.costUsd;
		if (at >= dayStart) dailyUsd += e.costUsd;
	}
	return { dailyUsd, monthlyUsd };
}

/**
 * Compute the current budget status. Shared by the internal gate query and the
 * admin dashboard query, and callable directly from a mutation ctx (aiGate)
 * since it only reads. Skips the ledger scan entirely when no ceiling is set.
 */
export async function computeBudgetStatus(ctx: QueryCtx | MutationCtx): Promise<BudgetStatus> {
	const config = resolveBudgetConfig();
	if (config.dailyUsd <= 0 && config.monthlyUsd <= 0) {
		return evaluateBudget(config, 0, 0);
	}
	const { dailyUsd, monthlyUsd } = await spentInCurrentPeriods(ctx);
	return evaluateBudget(config, dailyUsd, monthlyUsd);
}

/** Gate query for the autonomous route step + advisory aiGate. */
export const getBudgetStatus = internalQuery({
	args: {},
	handler: async (ctx): Promise<BudgetStatus> => computeBudgetStatus(ctx),
});

/** Admin dashboard read: remaining budget + warn state, all members. */
export const getBudgetStatusAdmin = adminQuery({
	args: {},
	handler: async (ctx): Promise<BudgetStatus> => computeBudgetStatus(ctx),
});
