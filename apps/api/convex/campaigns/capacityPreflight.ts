/**
 * Binding capacity pre-flight — the ctx-bound half of the P0-5 capacity gate
 * (deliverability plan rev 3). The pure predicate lives in `capacityPlan.ts`
 * and the warming projection in `../delivery/warmingCapacity.ts`; this module
 * only LOADS the inputs (projection, audience size) and maps "we could not
 * measure" onto "allow the send".
 *
 * The governing rule: NEVER refuse on missing data (plan D2/D10). No warming
 * state, stale warming state, a graduated deployment with no cap, an audience
 * too large to count inside the read budget, or a projection with no positive
 * capacity at all ALL resolve to "capacity unknown → allow". Blocking a
 * campaign because we could not read warming state, or because we ran out of
 * budget counting it, would be exactly the false blocker the plan forbids.
 */

import { v } from 'convex/values';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { loadRemainingCapacityByDay } from '../delivery/warmingCapacity';
import { audienceValidator, type StoredAudience } from './audience';
import { countAudience } from './audienceResolution';
import {
	MAX_PLAN_DAYS,
	planCampaignCapacity,
	type CampaignCapacityPlan,
	type CampaignCapacitySchedule,
} from './capacityPlan';

type Ctx = MutationCtx | QueryCtx;

/**
 * Rows the gate may EXAMINE while sizing the audience. The gate runs inside
 * `campaigns.scheduling.schedule` and `campaigns.campaigns.sendNow`, where an
 * unbounded segment scan would both exceed the Convex per-execution read limit
 * — turning a failure to MEASURE into a blocked SEND — and pull the whole live
 * contacts table into the mutation's OCC read set (D16). Well under the read
 * limit; exceeding it means "unknown capacity", never "too big".
 */
const AUDIENCE_EXAMINE_CEILING = 8_000;

/**
 * Multi-day plan plus whether capacity could be measured at all.
 *
 * Modelled as a discriminated union rather than `plan & { capacityKnown }` so
 * the unrepresentable "we refused, but we could not measure capacity" state
 * cannot be constructed: an unmeasured assessment is ALWAYS `fits: true`.
 */
export type CampaignCapacityAssessment =
	| { capacityKnown: false; fits: true }
	| { capacityKnown: true; fits: true }
	| { capacityKnown: true; fits: false; schedule: CampaignCapacitySchedule };

/**
 * Decide whether `audience` can be delivered inside the message-retention
 * horizon. Unknown capacity, an uncountable audience and unplannable
 * projections all answer `{ fits: true, capacityKnown: false }` — hold and
 * allow.
 *
 * `startsAt` (default `now`) is when the send begins; the projection AND the
 * retention horizon are both anchored there so a future-scheduled campaign is
 * judged against the capacity it will actually have.
 */
export async function assessCampaignCapacity(
	ctx: Ctx,
	options: { audience: StoredAudience; now: number; startsAt?: number }
): Promise<CampaignCapacityAssessment> {
	// Normalize the anchor ONCE, here at the boundary: a hostile or stale
	// `startsAt` (NaN, a timestamp in the past) collapses to `now`, so neither
	// the projection nor the pure planner has to defend against it.
	const requestedStart = options.startsAt;
	const startsAt =
		requestedStart !== undefined && Number.isFinite(requestedStart)
			? Math.max(options.now, requestedStart)
			: options.now;
	const remainingCapacityByDay = await loadRemainingCapacityByDay(ctx, {
		now: options.now,
		startsAt,
	});
	if (remainingCapacityByDay === null) return { capacityKnown: false, fits: true };

	// Bound the CANDIDATE count by CAPACITY, not by audience size. The verdict
	// is already decided once the count exceeds everything the deployment could
	// possibly send across the whole plan window, so there is no reason to stream
	// tens of thousands of audience documents inside a send mutation.
	const trailingRate = remainingCapacityByDay[remainingCapacityByDay.length - 1] ?? 0;
	const projectedTotal =
		remainingCapacityByDay.reduce((sum, day) => sum + day, 0) +
		Math.max(0, MAX_PLAN_DAYS - remainingCapacityByDay.length) * trailingRate;
	const counted = await countAudience(ctx, options.audience, {
		ceiling: projectedTotal + 1,
		examineCeiling: AUDIENCE_EXAMINE_CEILING,
	});
	// Ran out of read budget before the audience was sized: we did not measure
	// it, so we do not get to refuse it.
	if (counted.examineCeilingHit) return { capacityKnown: false, fits: true };

	const plan = planCampaignCapacity({
		// `eligible` is a lower bound when the count is capped, and refusing on a
		// lower bound is sound: a bigger audience fits even less well.
		audienceSize: counted.eligible,
		remainingCapacityByDay,
		maxMessageAgeMs: GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
		now: startsAt,
	});

	return toAssessment(plan, { audienceUnderCounted: counted.capped });
}

/**
 * Map a planner verdict onto an assessment. Pure, and exported so the
 * "unplannable → allow" branch is directly testable: real warming caps are
 * never zero, so the sentinel is unreachable through seeded integration state
 * and would otherwise ship untested.
 *
 * `audienceUnderCounted` marks a schedule built from a CAPPED count. The cap
 * trips on total candidates, so `eligible` is then a strict under-count and the
 * enumerated slices cannot be the whole story — the schedule is forced
 * `truncated` so the copy says "more than N days" instead of quoting a finish
 * date for an audience we never finished counting (D14 honesty).
 */
export function toAssessment(
	plan: CampaignCapacityPlan,
	options: { audienceUnderCounted?: boolean } = {}
): CampaignCapacityAssessment {
	if (plan.fits) return { capacityKnown: true, fits: true };
	// `days === 0` is the planner's "no capacity to schedule against" sentinel:
	// nothing could be scheduled, or the projection plateaus at zero before the
	// audience is covered. Either way it is missing data, not a refusal.
	if (plan.days === 0) return { capacityKnown: false, fits: true };
	const schedule = options.audienceUnderCounted ? { ...plan, truncated: true } : plan;
	return { capacityKnown: true, fits: false, schedule };
}

/**
 * UI-facing preview of the same assessment, so the campaign wizard can offer
 * "Sending over N days" as a first-class choice before the operator hits send.
 * A multi-day send is a normal, visible state for a warming deployment — never
 * an error, never a surprise.
 */
// all-members: deployment-wide sending capacity is not per-user data — it is the
// same warming projection every delivery screen already renders to any member,
// and the caller supplies the audience it is about to preview. No row is read
// that a member cannot already read through countRecipients / the warming pages.
export const getCampaignCapacityPlan = authedQuery({
	args: { audience: v.optional(audienceValidator), startsAt: v.optional(v.number()) },
	handler: async (ctx, args): Promise<CampaignCapacityAssessment> => {
		if (!args.audience) return { capacityKnown: false, fits: true };
		return await assessCampaignCapacity(ctx, {
			audience: args.audience,
			now: Date.now(),
			...(args.startsAt !== undefined ? { startsAt: args.startsAt } : {}),
		});
	},
});
