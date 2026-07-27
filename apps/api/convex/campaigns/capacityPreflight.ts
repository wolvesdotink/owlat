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
import { loadWarmingCapacity } from '../delivery/warmingCapacity';
import { campaignWarmingCapBinds } from '../lib/sendProviders/route';
import { audienceValidator, type StoredAudience } from './audience';
import { countAudience } from './audienceCandidates';
import {
	capacityWithinHorizon,
	planCampaignCapacity,
	totalPlannableCapacity,
	usableDayCount,
	type CampaignCapacityPlan,
	type CampaignCapacitySchedule,
} from './capacityPlan';
import { logWarn } from '../lib/runtimeLog';

type Ctx = MutationCtx | QueryCtx;

/**
 * DOCUMENTS the gate may read while sizing the audience. The gate runs inside
 * `campaigns.scheduling.schedule` and `campaigns.campaigns.sendNow`, where an
 * unbounded segment scan would both exceed the Convex per-execution read limit
 * — turning a failure to MEASURE into a blocked SEND — and pull the whole live
 * contacts table into the mutation's OCC read set (D16).
 *
 * DERIVATION. Convex allows 16,384 documents read per function execution. The
 * budget is charged in DOCUMENTS, not rows, because a row is not one document:
 * a topic candidate costs the membership PLUS its contact, and a segment
 * candidate costs the contact plus one point read per (contact × condition
 * lookup), so a segment with two `topic_membership` conditions costs three
 * documents per row. Charging rows would let this "bound" overrun the limit by
 * 2-3x on exactly the audiences it exists for — and in production the limit
 * THROWS, the fail-open catch swallows it, and the gate goes dark. The gate is
 * also not the only reader in the mutation: the enclosing `schedule` /
 * `sendNow` loads the campaign, template, domain and sender. 6,000 documents
 * leaves 10,384 of the 16,384 for everything else.
 *
 * Exhausting it is NOT a refusal and NOT a silent pass: the partial count is
 * kept as a LOWER BOUND on the audience and compared against the capacity
 * inside the retention horizon (see `measureCampaignCapacity`). A floor already
 * above that capacity is a sound refusal; only a floor below it is genuinely
 * unmeasured.
 *
 * THE HONEST INVARIANT — and its limit. The lower-bound rule only decides the
 * case where the floor EXCEEDS horizon capacity, so THE GATE CAN ONLY BIND
 * WHILE CAPACITY INSIDE THE RETENTION HORIZON IS BELOW WHAT THIS BUDGET CAN
 * COUNT. Once a deployment's horizon capacity grows past that (three IPs clear
 * a few thousand a day around schedule day 12), an audience larger than the
 * budget can count is allowed through and its tail expires exactly as it did
 * before this gate existed. That is a deliberate bound, not an oversight: the
 * alternative is refusing sends on an unmeasured audience, which D2 forbids.
 * The real fix for very large audiences is a denormalized audience-size
 * counter — the same follow-up `COUNT_CEILING` names — not a bigger budget.
 */
const AUDIENCE_DOCUMENT_BUDGET = 6_000;

/**
 * Multi-day plan plus whether capacity could be measured at all.
 *
 * Modelled as a discriminated union rather than `plan & { capacityKnown }` so
 * the unrepresentable "we refused, but we could not measure capacity" state
 * cannot be constructed: an unmeasured assessment is ALWAYS `fits: true`.
 */
/** What the gate needs to know about the send it is judging. */
export interface CampaignCapacityOptions {
	audience: StoredAudience;
	/**
	 * The campaign's From address. Used ONLY to re-verify the relay domain when
	 * deciding whether warm-up overflow can absorb the tail — never to gate the
	 * send on an external account.
	 */
	fromEmail?: string | undefined;
	now: number;
	startsAt?: number | undefined;
}

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
	options: CampaignCapacityOptions
): Promise<CampaignCapacityAssessment> {
	// FAIL OPEN, unconditionally. This runs inside `campaigns.scheduling.schedule`
	// and `campaigns.campaigns.sendNow`: an exception escaping here would not
	// refuse the campaign, it would make the send mutation THROW — a failure to
	// MEASURE blocking a SEND, exactly what D2 forbids. Every measurement fault
	// (a read limit, a corrupt segment, an unreadable row) degrades to "capacity
	// unknown → allow".
	try {
		return await measureCampaignCapacity(ctx, options);
	} catch (err) {
		logWarn('capacityPreflight: capacity could not be measured; allowing the send', err);
		return { capacityKnown: false, fits: true };
	}
}

async function measureCampaignCapacity(
	ctx: Ctx,
	options: CampaignCapacityOptions
): Promise<CampaignCapacityAssessment> {
	// FIRST, and before any projection is loaded: does the warming cap actually
	// bind THIS deployment's campaign traffic? Warm-up overflow to a verified
	// relay absorbs the tail instead of deferring it, and a campaign route that
	// does not dispatch through the own MTA has no warming cap at all — in both
	// shipped configurations the failure this gate exists to prevent cannot
	// happen, and refusing would be a false blocker on traffic that ships fine.
	if (!(await campaignWarmingCapBinds(ctx, { fromEmail: options.fromEmail, now: options.now }))) {
		return { capacityKnown: false, fits: true };
	}

	// Normalize the anchor ONCE, here at the boundary: a hostile or stale
	// `startsAt` (NaN, a timestamp in the past) collapses to `now`, so neither
	// the projection nor the pure planner has to defend against it.
	const requestedStart = options.startsAt;
	const startsAt =
		requestedStart !== undefined && Number.isFinite(requestedStart)
			? Math.max(options.now, requestedStart)
			: options.now;
	const projection = await loadWarmingCapacity(ctx, { now: options.now, startsAt });
	if (projection === null) return { capacityKnown: false, fits: true };
	const remainingCapacityByDay = projection.byDay;

	// The projection stops at the last day it can BOUND: schedule day 30 removes
	// the warming cap altogether, and clamping that to a display sentinel would
	// make the array a LOWER bound and let the gate refuse a campaign that fits.
	// If it does not reach across the retention horizon, capacity inside that
	// horizon is unbounded — unknown, and unknown allows.
	if (remainingCapacityByDay.length < usableDayCount(startsAt, GOVERNED_MTA_MAX_MESSAGE_AGE_MS)) {
		return { capacityKnown: false, fits: true };
	}

	// Bound the CANDIDATE count by CAPACITY, not by audience size. The verdict
	// is already decided once the count exceeds everything the deployment could
	// possibly send across the whole plan window, so there is no reason to stream
	// tens of thousands of audience documents inside a send mutation.
	const counted = await countAudience(ctx, options.audience, {
		ceiling: totalPlannableCapacity(remainingCapacityByDay) + 1,
		documentBudget: AUDIENCE_DOCUMENT_BUDGET,
	});

	// The suppression set could not be read in full, so candidates were filtered
	// through a SUBSET of the blocklist and `eligible` is an OVER-count. Unlike a
	// spent read budget it bounds the audience in NEITHER direction, so it cannot
	// license a refusal — it is simply "unmeasured".
	if (counted.completeness === 'suppression_truncated') {
		return { capacityKnown: false, fits: true };
	}

	// Ran out of read budget before the audience was sized. The partial count is
	// still a valid LOWER BOUND on the audience, and a lower bound answers one
	// question soundly: if even the floor already exceeds everything the horizon
	// can carry, the real audience — which can only be bigger — cannot finish
	// either, so refusing is sound. A floor at or below horizon capacity decides
	// nothing, and undecided means allow. Throwing the partial count away instead
	// would turn the read budget into an OFF switch for the gate on exactly the
	// large audiences it exists to catch.
	if (counted.completeness === 'read_budget_exhausted') {
		const horizonCapacity = capacityWithinHorizon({
			remainingCapacityByDay,
			maxMessageAgeMs: GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
			now: startsAt,
		});
		if (counted.eligible <= horizonCapacity) return { capacityKnown: false, fits: true };
	}

	const plan = planCampaignCapacity({
		// `eligible` is a lower bound whenever the count did not run to completion,
		// and refusing on a lower bound is sound: a bigger audience fits even less
		// well.
		audienceSize: counted.eligible,
		remainingCapacityByDay,
		maxMessageAgeMs: GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
		now: startsAt,
	});

	return toAssessment(plan, { audienceUnderCounted: counted.completeness !== 'exact' });
}

/**
 * Map a planner verdict onto an assessment. Pure, and exported so the
 * "unplannable → allow" branch is directly testable: real warming caps are
 * never zero, so the sentinel is unreachable through seeded integration state
 * and would otherwise ship untested.
 *
 * `audienceUnderCounted` marks a schedule built from a count that did not run to
 * completion — `eligible` is then a strict under-count, so the enumerated slices
 * cover at least, not exactly, the audience. It is recorded on its OWN field
 * rather than folded into `truncated`: "the enumeration stopped at
 * MAX_PLAN_DAYS" and "the audience is at least N" are different facts and get
 * different copy ("at least N days" vs "more than 60 days"). Folding them made
 * a five-day schedule render as "more than 60 days", which is simply false
 * (D14 honesty).
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
	const schedule: CampaignCapacitySchedule = options.audienceUnderCounted
		? { ...plan, audienceUnderCounted: true }
		: plan;
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
	args: {
		audience: v.optional(audienceValidator),
		fromEmail: v.optional(v.string()),
		startsAt: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<CampaignCapacityAssessment> => {
		if (!args.audience) return { capacityKnown: false, fits: true };
		return await assessCampaignCapacity(ctx, {
			audience: args.audience,
			fromEmail: args.fromEmail,
			now: Date.now(),
			...(args.startsAt !== undefined ? { startsAt: args.startsAt } : {}),
		});
	},
});
