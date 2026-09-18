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
 *   - ADVISORY, user-triggered features (`mail/ai/gate.ts`) degrade gracefully
 *     within a RESERVE: they are cut off once remaining headroom drops below the
 *     reserve fraction, preserving the tail of the budget for the critical
 *     drafting path rather than letting manual actions drain it to $0.
 *
 * Budgets are configured via env (see `lib/env.ts`); an unset / `0` limit means
 * "no limit for that period" and the gate is a no-op (today's behaviour).
 * Spend is a best-effort estimate over a bounded recent-events scan — the same
 * posture as the dashboard aggregation it reuses. A scan that runs out of budget
 * before it reaches the start of the period says so, and says what the rate it
 * DID see would extrapolate to, but the enforced figure stays the counted one:
 * see {@link projectScannedSpend}.
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
	/**
	 * What the scanned rate extrapolates to over the whole period. Equal to
	 * `spentUsd` unless the scan was truncated, and never smaller.
	 *
	 * ADVISORY, NOT ENFORCED. `state` and `advisoryAllowed` above bind on the
	 * COUNTED figure, because a projection is a rate read off whatever window the
	 * newest rows happened to cover: a bulk re-index that emits twelve thousand
	 * rows in half an hour would extrapolate that half hour over the whole day and
	 * withhold auto-send over money nobody spent. A ceiling that blocks mail is
	 * not the place for an extrapolation; a warning is.
	 */
	projectedUsd: number;
	/**
	 * True when the ledger scan hit its cap before reaching the start of the
	 * period, so `projectedUsd` is an extrapolation and the counted `spentUsd` is
	 * a floor rather than a total.
	 */
	projected: boolean;
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
	/**
	 * True at or above the warn threshold (but not yet blocking) — on the counted
	 * figure OR on a projection. This is where a truncated scan is allowed to
	 * raise its voice: `warn` is read by surfaces and by nothing that gates mail.
	 */
	warn: boolean;
	/** True when either period's spend is a projection ({@link PeriodBudget.projected}). */
	projected: boolean;
	/** Human-readable reason when a gate should block (empty when unconstrained). */
	reason: string;
}

/** Evaluate one period against its ceiling. Pure — the unit-tested core. */
export function evaluatePeriod(
	limitUsd: number,
	spentUsd: number,
	warnFraction: number,
	advisoryReserveFraction: number,
	projectedUsd = spentUsd
): PeriodBudget {
	const projected = projectedUsd > spentUsd;
	if (limitUsd <= 0) {
		return {
			configured: false,
			limitUsd: 0,
			spentUsd,
			remainingUsd: 0,
			state: 'ok',
			advisoryAllowed: true,
			projectedUsd,
			projected,
		};
	}
	const remainingUsd = Math.max(0, limitUsd - spentUsd);
	let state: BudgetState = 'ok';
	if (spentUsd >= limitUsd) state = 'exceeded';
	else if (spentUsd >= limitUsd * warnFraction) state = 'warn';
	// Advisory keeps a reserve for the autonomous drafting path: it is allowed
	// only while remaining headroom is strictly above the reserve floor.
	const advisoryAllowed = remainingUsd > limitUsd * advisoryReserveFraction;
	return {
		configured: true,
		limitUsd,
		spentUsd,
		remainingUsd,
		state,
		advisoryAllowed,
		projectedUsd,
		projected,
	};
}

/** Whether a figure is at or past the warn line of a configured ceiling. */
function reachesWarn(period: PeriodBudget, warnFraction: number, usd: number): boolean {
	return period.configured && usd >= period.limitUsd * warnFraction;
}

const WORST: Record<BudgetState, number> = { ok: 0, warn: 1, exceeded: 2 };

/** Combine per-period budgets + spend into the shared status object. Pure. */
export function evaluateBudget(
	config: SpendBudgetConfig,
	spentDailyUsd: number,
	spentMonthlyUsd: number,
	projectedUsd: { daily?: number; monthly?: number } = {}
): BudgetStatus {
	const daily = evaluatePeriod(
		config.dailyUsd,
		spentDailyUsd,
		config.warnFraction,
		config.advisoryReserveFraction,
		projectedUsd.daily
	);
	const monthly = evaluatePeriod(
		config.monthlyUsd,
		spentMonthlyUsd,
		config.warnFraction,
		config.advisoryReserveFraction,
		projectedUsd.monthly
	);

	const configured = daily.configured || monthly.configured;
	const state: BudgetState =
		WORST[daily.state] >= WORST[monthly.state] ? daily.state : monthly.state;
	const autonomousAutoSendAllowed = daily.state !== 'exceeded' && monthly.state !== 'exceeded';
	const advisoryAllowed = daily.advisoryAllowed && monthly.advisoryAllowed;
	// The projection's one job: a truncated scan whose observed rate would blow
	// through a ceiling raises the warning, and nothing else. It never withholds
	// auto-send and never cuts advisory AI off — a rate read from a burst is not
	// evidence a deployment spent anything.
	const warn =
		state !== 'ok' ||
		reachesWarn(daily, config.warnFraction, daily.projectedUsd) ||
		reachesWarn(monthly, config.warnFraction, monthly.projectedUsd);

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
		projected: daily.projected || monthly.projected,
		reason,
	};
}

/**
 * Rows read per evaluation. Raised from 10,000, and still a cap: Convex caps a
 * function execution at 16,384 documents, so no constant can promise to cover a
 * busy month — which is the whole reason the scan below reports its coverage
 * instead of quietly returning whatever it managed to add up.
 *
 * One row per priced call, and the decision plane adds one per inbound message
 * on top of the language plane's, so a deployment doing real volume crosses this
 * within a month and, on a heavy day, within a day.
 */
const MAX_EVENTS_SCANNED = 12_000;

/** One ledger row, as the projection reads it. Structural, so it unit-tests with plain rows. */
export interface ScannedSpendRow {
	/** The row's effective timestamp: `createdAt`, or `_creationTime` for pre-field rows. */
	readonly at: number;
	readonly costUsd: number;
}

/** Period boundaries the scan is summed against, in ms since the epoch. */
export interface SpendPeriodBounds {
	readonly now: number;
	readonly dayStart: number;
	readonly monthStart: number;
}

/**
 * Spend per period: what the scan COUNTED, and what the rate it saw would
 * extrapolate to over the whole period. The counted figures are what the gate
 * binds on; the projected ones only ever raise a warning.
 */
export interface ScannedSpend {
	dailyUsd: number;
	monthlyUsd: number;
	/** ≥ `dailyUsd`; equal to it when the scan reached the start of the day. */
	dailyProjectedUsd: number;
	/** ≥ `monthlyUsd`; equal to it when the scan reached the start of the month. */
	monthlyProjectedUsd: number;
}

/**
 * Sum a newest-first ledger slice into the two periods, and say what the part it
 * reached would extrapolate to over the part it did not.
 *
 * TWO NUMBERS, NOT ONE, and the reason is the shape of the scan. A cap that
 * silently truncates reports its SMALLEST number precisely on the runaway day
 * the ceiling was written for, so an under-report is not a delay, it is the
 * failure mode — the deployment needs to be told. But the rate the scan sees is
 * whatever window the newest rows happened to cover, and rows do not arrive
 * evenly: a bulk knowledge re-index or a campaign personalisation pass emits
 * twelve thousand rows in half an hour, and extrapolating that half hour across
 * a twelve-hour day would report twenty-four times the money that was spent.
 *
 * So the scan counts what it reached and projects what it did not, and the two
 * answers are kept apart: `evaluatePeriod` binds `state` and `advisoryAllowed`
 * on the counted figure, and the projection drives `warn` and the surfaces.
 * Blocking mail on an extrapolation would be trading a measurable failure mode
 * for an unmeasurable one.
 */
export function projectScannedSpend(
	rows: readonly ScannedSpendRow[],
	bounds: SpendPeriodBounds,
	truncated: boolean
): ScannedSpend {
	const { now, dayStart, monthStart } = bounds;
	let dailyUsd = 0;
	let monthlyUsd = 0;
	let oldest = now;
	for (const row of rows) {
		// Coverage is tracked over EVERY scanned row, including ones older than the
		// month: a scan that reached back past the period start covered all of it,
		// whether or not those rows counted towards the total.
		if (row.at < oldest) oldest = row.at;
		if (row.at < monthStart) continue;
		monthlyUsd += row.costUsd;
		if (row.at >= dayStart) dailyUsd += row.costUsd;
	}
	const counted = {
		dailyUsd,
		monthlyUsd,
		dailyProjectedUsd: dailyUsd,
		monthlyProjectedUsd: monthlyUsd,
	};
	if (!truncated) return counted;
	// `Math.max(1, …)` keeps the rate finite when every scanned row landed in the
	// same millisecond.
	const scannedSpanMs = Math.max(1, now - oldest);
	const scale = (periodStart: number): number =>
		periodStart >= oldest ? 1 : (now - periodStart) / scannedSpanMs;
	return {
		dailyUsd,
		monthlyUsd,
		dailyProjectedUsd: dailyUsd * scale(dayStart),
		monthlyProjectedUsd: monthlyUsd * scale(monthStart),
	};
}

/**
 * Estimated spend in the current UTC day and month from the `llmUsageEvents`
 * ledger. Bounded scan (same posture as `getSpendByFeature`): a best-effort
 * estimate, never billing — but one that knows when it ran out of scan, and
 * reports what it did not reach as a projection instead of as nothing.
 */
async function spentInCurrentPeriods(ctx: QueryCtx | MutationCtx): Promise<ScannedSpend> {
	const now = Date.now();
	const d = new Date(now);
	const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);

	// One row past the cap, kept out of the sum: its existence is how the scan
	// learns it was truncated, instead of inferring it from a full page (which
	// would misread a month that ends exactly on the cap as incomplete).
	const events = await ctx.db
		.query('llmUsageEvents')
		.withIndex('by_creation_time', (q) => q.gte('_creationTime', monthStart))
		.order('desc')
		.take(MAX_EVENTS_SCANNED + 1);
	const truncated = events.length > MAX_EVENTS_SCANNED;
	const scanned = truncated ? events.slice(0, MAX_EVENTS_SCANNED) : events;

	const rows = scanned.map((e) => ({
		// `createdAt` is the caller's wall clock; fall back to the system
		// `_creationTime` if an older row predates the field.
		at: e.createdAt ?? e._creationTime,
		costUsd: e.costUsd,
	}));
	return projectScannedSpend(rows, { now, dayStart, monthStart }, truncated);
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
	const spend = await spentInCurrentPeriods(ctx);
	return evaluateBudget(config, spend.dailyUsd, spend.monthlyUsd, {
		daily: spend.dailyProjectedUsd,
		monthly: spend.monthlyProjectedUsd,
	});
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
