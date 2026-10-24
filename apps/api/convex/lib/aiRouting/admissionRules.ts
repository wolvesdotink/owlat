/**
 * Spend admission: the decision rule.
 *
 * One pure function, {@link evaluateAdmission}, answers "may a call that may
 * cost `microusd` start now?" from the complete settled totals of the current
 * UTC day and month (`llmSpendPeriods`, derived only from the ledger) plus the
 * outstanding holds (`llmReservations` in `held`). The caller reads both in
 * the same Convex mutation that inserts the hold, so two admissions that race
 * conflict and serialize: neither can be admitted on headroom the other took.
 *
 * Per configured period (a ceiling of 0 means "no ceiling for that period"),
 * with `used` = settled + held across every plane and class:
 *
 * 1. Total: `used + microusd` stays within the ceiling. Every class.
 * 2. Triage allowance: `triageAllowanceFraction` of the ceiling is held
 *    back for paid guard and classify calls (class `triage`). Other classes
 *    may not eat into the part of it triage has not used yet; triage itself
 *    may use any headroom that remains.
 * 3. Advisory reserve: work that is not the Team pipeline (interactive and
 *    background priority) also leaves `advisoryReserveFraction` of the ceiling
 *    for the pipeline, as the user-triggered gate did before admission.
 * 4. Plane capacity: the decision and embedding planes may each use at most a
 *    fixed share of the ceiling, so a decision outage or a paid re-embed
 *    cannot consume the writer's budget. The language plane has no share of
 *    its own: it may use whatever the other rules leave.
 * 5. Shadow: class `shadow` draws only on the shadow allowance of the
 *    day (`shadowAllowanceUsd`), which is zero unless a switch is shadowed and
 *    a daily ceiling or a finite `shadowCapUsd` bounds it. The allowance
 *    applies with or without a ceiling.
 *
 * Pure: no Convex, no clock.
 */

import type { BudgetHoldReason } from '@owlat/shared/aiRouting';
import type { LlmUsagePlane } from '../llmUsageTags';
import type { AdmissionPriority, BudgetClass } from '../validators/aiRouting';

/**
 * The most of each ceiling the decision and embedding planes may use. The
 * language plane is the writer's and is bounded only by the ceiling itself.
 */
export const PLANE_CAPACITY_FRACTION: Readonly<Record<LlmUsagePlane, number>> = Object.freeze({
	language: 1,
	decision: 0.2,
	embedding: 0.2,
});

/** Micro-USD per plane and budget class. */
export type SpendTotals = Record<LlmUsagePlane, Record<BudgetClass, number>>;

/** One period's usage: what the ledger settled, and what outstanding holds may still spend. */
export interface PeriodUsage {
	readonly settled: SpendTotals;
	readonly held: SpendTotals;
}

export interface AdmissionLimits {
	/** Integer micro-USD; 0 ⇒ no daily ceiling. */
	readonly dailyCeilingMicrousd: number;
	/** Integer micro-USD; 0 ⇒ no monthly ceiling. */
	readonly monthlyCeilingMicrousd: number;
	readonly triageAllowanceFraction: number;
	readonly advisoryReserveFraction: number;
	/** The day's shadow allowance in micro-USD; 0 ⇒ shadow traffic is refused. */
	readonly shadowAllowanceMicrousd: number;
}

export interface AdmissionRequestShape {
	readonly plane: LlmUsagePlane;
	readonly budgetClass: BudgetClass;
	readonly priority: AdmissionPriority;
	/** Integer micro-USD the call may cost (its hold). */
	readonly microusd: number;
}

/** Which rule refused. `unverifiable` is decided before the rule runs. */
export type AdmissionLimit =
	| 'ceiling'
	| 'triage_allowance'
	| 'advisory_reserve'
	| 'plane_capacity'
	| 'shadow_allowance'
	| 'unverifiable';

export type AdmissionVerdict =
	| { readonly isAdmitted: true }
	| {
			readonly isAdmitted: false;
			readonly reason: BudgetHoldReason;
			readonly limit: AdmissionLimit;
	  };

const PLANES: readonly LlmUsagePlane[] = ['language', 'decision', 'embedding'];
const CLASSES: readonly BudgetClass[] = ['standard', 'triage', 'shadow'];

export function emptyTotals(): SpendTotals {
	return {
		language: { standard: 0, triage: 0, shadow: 0 },
		decision: { standard: 0, triage: 0, shadow: 0 },
		embedding: { standard: 0, triage: 0, shadow: 0 },
	};
}

export function emptyUsage(): PeriodUsage {
	return { settled: emptyTotals(), held: emptyTotals() };
}

function sumAll(totals: SpendTotals): number {
	let sum = 0;
	for (const plane of PLANES) for (const budgetClass of CLASSES) sum += totals[plane][budgetClass];
	return sum;
}

function sumClass(totals: SpendTotals, budgetClass: BudgetClass): number {
	let sum = 0;
	for (const plane of PLANES) sum += totals[plane][budgetClass];
	return sum;
}

function sumPlane(totals: SpendTotals, plane: LlmUsagePlane): number {
	let sum = 0;
	for (const budgetClass of CLASSES) sum += totals[plane][budgetClass];
	return sum;
}

/** `fraction` of an integer ceiling, rounded down (a share is never larger than stated). */
function share(ceilingMicrousd: number, fraction: number): number {
	return Math.floor(ceilingMicrousd * fraction);
}

const refuse = (reason: BudgetHoldReason, limit: AdmissionLimit): AdmissionVerdict =>
	Object.freeze({ isAdmitted: false, reason, limit });

/** Rules 1–4 for one period with a ceiling. Null: admitted for this period. */
function periodVerdict(
	ceiling: number,
	reason: BudgetHoldReason,
	usage: PeriodUsage,
	limits: AdmissionLimits,
	request: AdmissionRequestShape
): AdmissionVerdict | null {
	const after = sumAll(usage.settled) + sumAll(usage.held) + request.microusd;
	if (after > ceiling) return refuse(reason, 'ceiling');
	if (request.budgetClass !== 'triage') {
		const triageUsed = sumClass(usage.settled, 'triage') + sumClass(usage.held, 'triage');
		const triageUnused = Math.max(0, share(ceiling, limits.triageAllowanceFraction) - triageUsed);
		if (after > ceiling - triageUnused) return refuse(reason, 'triage_allowance');
		if (request.priority !== 'pipeline') {
			const reserve = share(ceiling, limits.advisoryReserveFraction);
			if (after > ceiling - triageUnused - reserve) return refuse(reason, 'advisory_reserve');
		}
	}
	if (request.plane !== 'language') {
		const planeUsed =
			sumPlane(usage.settled, request.plane) +
			sumPlane(usage.held, request.plane) +
			request.microusd;
		if (planeUsed > share(ceiling, PLANE_CAPACITY_FRACTION[request.plane])) {
			return refuse(reason, 'plane_capacity');
		}
	}
	return null;
}

/** Whether any ceiling is configured. Without one, only shadow traffic is admitted against a bound. */
export function hasCeiling(
	limits: Pick<AdmissionLimits, 'dailyCeilingMicrousd' | 'monthlyCeilingMicrousd'>
): boolean {
	return limits.dailyCeilingMicrousd > 0 || limits.monthlyCeilingMicrousd > 0;
}

/** The admission rule. Day first, then month; shadow last. */
export function evaluateAdmission(
	limits: AdmissionLimits,
	usage: { readonly day: PeriodUsage; readonly month: PeriodUsage },
	request: AdmissionRequestShape
): AdmissionVerdict {
	if (!Number.isSafeInteger(request.microusd) || request.microusd < 0) {
		return refuse('spend_unverifiable', 'unverifiable');
	}
	if (limits.dailyCeilingMicrousd > 0) {
		const verdict = periodVerdict(
			limits.dailyCeilingMicrousd,
			'daily_ceiling',
			usage.day,
			limits,
			request
		);
		if (verdict) return verdict;
	}
	if (limits.monthlyCeilingMicrousd > 0) {
		const verdict = periodVerdict(
			limits.monthlyCeilingMicrousd,
			'monthly_ceiling',
			usage.month,
			limits,
			request
		);
		if (verdict) return verdict;
	}
	if (request.budgetClass === 'shadow') {
		const shadowUsed =
			sumClass(usage.day.settled, 'shadow') + sumClass(usage.day.held, 'shadow') + request.microusd;
		if (limits.shadowAllowanceMicrousd <= 0 || shadowUsed > limits.shadowAllowanceMicrousd) {
			return refuse('daily_ceiling', 'shadow_allowance');
		}
	}
	return Object.freeze({ isAdmitted: true });
}
