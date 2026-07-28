/**
 * The campaign capacity refusal, read off an Operation error.
 *
 * `campaigns.preflight` refuses a campaign that provably cannot finish inside
 * the MTA's message-retention horizon and attaches the multi-day schedule it
 * WOULD take (`reason: 'exceeds_sending_capacity'`, `data.capacityPlan`). That
 * is not a fault — it is an offer, and the deliverability plan (D14) is explicit
 * that a multi-day send is a normal, visible state for a warming deployment,
 * never an error and never a surprise. So the caller claims the failure through
 * `useBackendOperation`'s `onError` and renders THIS instead of a red toast.
 *
 * Pure and runtime-validated: the payload crosses the wire as `unknown`, and a
 * shape we do not recognise falls back to `null` — which puts the operation
 * back on the default toast path rather than rendering a half-empty panel.
 */

import type { OperationError } from '@owlat/shared/operationError';

/** The refusal's multi-day schedule, in the shape the UI renders. */
export interface CampaignCapacitySchedulePlan {
	/**
	 * Days the send needs. Always >= 1 — the backend's `days === 0` sentinel
	 * means "capacity unknown" and never reaches a refusal.
	 */
	days: number;
	/** Per-day recipient slice sizes; `slices.length === days`. */
	slices: number[];
	/** End of the last sliced day (ms since epoch). */
	finishesAt: number;
	/** Recipients the slices actually cover. Below the audience when `truncated`. */
	covered: number;
	/** The enumeration stopped early, so the real finish is LATER than `finishesAt`. */
	truncated: boolean;
	/** The audience size is itself a lower bound, so `days` is a floor. */
	audienceUnderCounted: boolean;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Extract the capacity schedule from an Operation error, or `null` when this
 * failure is not a capacity refusal (or does not carry a schedule we can
 * render).
 */
export function capacityRefusalPlan(error: OperationError): CampaignCapacitySchedulePlan | null {
	const data = error.data;
	if (!data || data['reason'] !== 'exceeds_sending_capacity') return null;
	const plan = data['capacityPlan'];
	if (typeof plan !== 'object' || plan === null) return null;

	const candidate = plan as Record<string, unknown>;
	const days = candidate['days'];
	const slices = candidate['slices'];
	const finishesAt = candidate['finishesAt'];
	const covered = candidate['covered'];
	if (!isFiniteNumber(days) || days < 1) return null;
	if (!isFiniteNumber(finishesAt) || !isFiniteNumber(covered)) return null;
	if (!Array.isArray(slices)) return null;
	const numericSlices: number[] = [];
	for (const slice of slices as readonly unknown[]) {
		if (!isFiniteNumber(slice)) return null;
		numericSlices.push(slice);
	}

	return {
		days,
		slices: numericSlices,
		finishesAt,
		covered,
		truncated: candidate['truncated'] === true,
		audienceUnderCounted: candidate['audienceUnderCounted'] === true,
	};
}

/**
 * The headline for a capacity schedule. Each variant says exactly as much as
 * the plan actually knows (D14 — say the quiet part):
 *
 *  - `truncated` — the enumeration stopped with recipients still unscheduled,
 *    so `days` is NOT a finish date and must not be quoted as one.
 *  - `audienceUnderCounted` — the enumeration finished, but of an audience we
 *    only know a lower bound for, so `days` is a floor.
 *  - neither — `days` is the projected finish.
 */
export function capacityScheduleHeadline(plan: CampaignCapacitySchedulePlan): string {
	if (plan.truncated) return `Sending over more than ${plan.days} days`;
	const dayWord = plan.days === 1 ? 'day' : 'days';
	if (plan.audienceUnderCounted) return `Sending over at least ${plan.days} ${dayWord}`;
	return `Sending over ${plan.days} ${dayWord}`;
}
