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

/**
 * A sentence the renderer translates. This module is module scope and never
 * calls `useI18n`, so the copy it decides travels as an i18n key plus the
 * parameters that key interpolates (see the UI-localization guide).
 */
export type CapacityMessage = { key: string; params?: Record<string, unknown> };

/** The refusal's multi-day schedule, in the shape the UI renders. */
export interface CampaignCapacitySchedulePlan {
	/**
	 * Days the send needs. Always >= 1 — the backend's `days === 0` sentinel
	 * means "capacity unknown" and never reaches a refusal.
	 */
	days: number;
	/** Per-day recipient slice sizes. `slices.length === days`, checked on read. */
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
	// ONE SLICE PER DAY, or this is not a plan we can render. Every row's date is
	// derived BACKWARDS from `finishesAt` through `days`
	// (`capacitySliceDayStart`), so a slice list of a different length silently
	// labels each row with the wrong date — a confident, wrong schedule rather
	// than the toast a payload we do not recognise is supposed to fall back to.
	if (numericSlices.length !== days) return null;

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
export function capacityScheduleHeadline(plan: CampaignCapacitySchedulePlan): CapacityMessage {
	const params = { days: plan.days };
	if (plan.truncated) {
		return { key: 'shared.campaignCapacityRefusal.headline.moreThan', params };
	}
	const plural = plan.days === 1 ? 'one' : 'other';
	if (plan.audienceUnderCounted) {
		return { key: `shared.campaignCapacityRefusal.headline.atLeast.${plural}`, params };
	}
	return { key: `shared.campaignCapacityRefusal.headline.over.${plural}`, params };
}

/** One UTC day, in ms. The backend slices the schedule on UTC day boundaries. */
export const CAPACITY_DAY_MS = 86_400_000;

/**
 * UTC start of the day slice `index` sends on.
 *
 * The plan's days are UTC days anchored on the SEND START (which is the
 * scheduled time, not `now` — a campaign scheduled three days out starts its
 * first slice three days out), and `finishesAt` is the EXCLUSIVE end of the
 * last sliced day. Deriving every row's date backwards from `finishesAt` is
 * what keeps the panel's dates and the backend's slices from drifting: there
 * is exactly one anchor, and the caller never re-derives one from `Date.now()`.
 */
export function capacitySliceDayStart(plan: CampaignCapacitySchedulePlan, index: number): number {
	return plan.finishesAt - (plan.days - index) * CAPACITY_DAY_MS;
}

/**
 * Format a UTC day for display.
 *
 * ALWAYS in UTC, never the viewer's zone. The plan's instants are UTC day
 * boundaries, so rendering them locally shifts every date by a day for half the
 * world and would show two operators two different finish dates for the same
 * plan.
 *
 * The ZONE is pinned; the LANGUAGE is not. Callers inside a component pass
 * `useI18n().locale.value` so the weekday and month read in the active locale.
 */
export function formatCapacityDay(
	atMs: number,
	style: 'long' | 'short' = 'long',
	locale = 'en-US'
): string {
	return new Intl.DateTimeFormat(locale, {
		timeZone: 'UTC',
		weekday: style === 'long' ? 'long' : 'short',
		month: style === 'long' ? 'long' : 'short',
		day: 'numeric',
	}).format(new Date(atMs));
}

/**
 * The last day recipients actually go out on (ms inside it).
 *
 * `finishesAt` is a HALF-OPEN interval end — the UTC midnight that starts the
 * day AFTER the last sending day — so it is closed exactly once, here, at the
 * render boundary. Formatting `finishesAt` itself would name the wrong day.
 */
export function capacityFinishDayAt(plan: CampaignCapacitySchedulePlan): number {
	return plan.finishesAt - 1;
}

/** Is `dayStartMs` inside the same UTC day as `now`? */
export function isCapacityDayToday(dayStartMs: number, now: number): boolean {
	return Math.floor(dayStartMs / CAPACITY_DAY_MS) === Math.floor(now / CAPACITY_DAY_MS);
}

/**
 * The finish sentence, or `null` when the plan carries no finish worth quoting.
 * Same rule as the headline, and stated here rather than in the template so the
 * two cannot drift: a truncated enumeration has no finish at all, and an
 * under-counted audience has one it can only be later than.
 *
 * The pairing is the whole point — "Sending over at least 5 days" beside a bare
 * "Everyone is reached by Friday" reads as a promise for Friday, which is
 * exactly the date the plan just said it does not have (D14).
 */
export function capacityFinishSentence(
	plan: CampaignCapacitySchedulePlan,
	locale = 'en-US'
): CapacityMessage | null {
	if (plan.truncated) return null;
	const params = { day: formatCapacityDay(capacityFinishDayAt(plan), 'long', locale) };
	if (plan.audienceUnderCounted) {
		return { key: 'shared.campaignCapacityRefusal.finish.earliest', params };
	}
	return { key: 'shared.campaignCapacityRefusal.finish.exact', params };
}
