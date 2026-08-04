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
import { loadPacedWarmingCapacity } from '../delivery/pacedWarmingCapacity';
import {
	campaignWarmingCapBinds,
	type OwnArmShareBounds,
	type WarmingCapNotBindingReason,
} from '../lib/sendProviders/warmingCapGate';
import { audienceValidator, type StoredAudience } from './audience';
import { countAudience, type AudienceCountCompleteness } from './audienceCandidates';
import {
	buildCapacitySchedule,
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
 * kept as a LOWER BOUND on the audience and planned against the capacity inside
 * the retention horizon like any other (see {@link assessCountedPlan}). A floor
 * that capacity cannot carry is a sound refusal; a floor it can carry is
 * genuinely unmeasured — never an approval.
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

/**
 * Multi-day plan plus whether capacity could be measured at all.
 *
 * Modelled as a discriminated union rather than `plan & { capacityKnown }` so
 * the unrepresentable "we refused, but we could not measure capacity" state
 * cannot be constructed: an unmeasured assessment is ALWAYS `fits: true`.
 */
export type CampaignCapacityAssessment =
	| { capacityKnown: false; fits: true; unknownReason: CapacityUnknownReason }
	| { capacityKnown: true; fits: true }
	| { capacityKnown: true; fits: false; schedule: CampaignCapacitySchedule };

/**
 * WHY capacity could not be measured. Every `capacityKnown: false` arm carries
 * one (plan D12 — every decision carries a recorded, human-readable reason;
 * D14 — the UI has to be able to say "measurement confidence: low" and name
 * what would improve it).
 *
 * The first three are the warming-cap gate's verdict (`warmingCapGate.ts`) and
 * mean the cap is not a constraint at all; the rest are genuine measurement
 * faults, where the send is allowed precisely because nothing is known.
 */
export type CapacityUnknownReason =
	| WarmingCapNotBindingReason
	/** No warming state, stale sync, graduated pool, or no active campaign IP. */
	| 'no_projection'
	/** The caller has not chosen an audience yet — the preview has nothing to judge. */
	| 'no_audience'
	/** The projection stops before the retention horizon: capacity is unbounded there. */
	| 'projection_shorter_than_horizon'
	/** The suppression set was truncated, so `eligible` is an over-count that bounds nothing. */
	| 'audience_over_counted'
	/** The count stopped short (read budget or candidate ceiling) and the floor it did reach fits. */
	| 'audience_under_counted'
	/** The projection carries no plannable capacity at all (the planner's `days === 0`). */
	| 'unplannable_projection'
	/**
	 * The audience finishes inside the horizon at the own arm's share FLOOR but
	 * not at its PEAK. Under a split route (`adaptive_mix`) how much of an
	 * audience meets the warming cap depends on how it falls across the ramp
	 * cells, and nothing has counted that: the campaign is neither provably
	 * unfinishable (so refusing would be a false blocker, D2) nor provably fine
	 * (so claiming `capacityKnown: true` would be the exact tail-expiry this gate
	 * exists to prevent). "Unmeasured" is the only honest answer, and it allows.
	 */
	| 'mix_composition_unknown'
	/** The measurement itself threw; the gate failed open. */
	| 'measurement_failed';

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
		return { capacityKnown: false, fits: true, unknownReason: 'measurement_failed' };
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
	const capVerdict = await campaignWarmingCapBinds(ctx, {
		fromEmail: options.fromEmail,
		now: options.now,
	});
	if (!capVerdict.binds) {
		return { capacityKnown: false, fits: true, unknownReason: capVerdict.why };
	}

	// ONLY THE OWN ARM MEETS THE CAP, AND ITS TWO BOUNDS SAY DIFFERENT THINGS.
	// Under a split route (`adaptive_mix`) the reference arm's share of the
	// audience relays out unmetered, so the warming projection bounds own-arm
	// volume and nothing more — measuring the whole audience against it would
	// quote a 95%-relayed campaign a multi-day plan it does not need (D2). But
	// own-arm volume is `sum over cells of share_c x audience_c` and nothing has
	// counted THIS audience by cell, so only two statements are sound: at least
	// `floor x audience` messages meet the cap, and at most `peak x audience` do.
	// The floor is therefore what may license a REFUSAL and the peak is what may
	// license "it fits" — an audience between them is unmeasured. Rounds UP so a
	// fractional message is never dropped; every non-splitting strategy answers
	// floor === peak === 1, where both statements collapse into the identity.
	//
	// THE SHARE SCALES THE DECISION ONLY, NEVER THE PLAN THAT IS QUOTED. Own-arm
	// volume answers "can the warming cap strand this campaign"; it is not a
	// schedule anyone will run, and enumerating it as one hands the operator a
	// finish date the walker misses by roughly `1 / share` (see
	// {@link quotedRefusalSchedule}).
	const { floor: ownArmFloor, peak: ownArmPeak } = capVerdict.ownArmShare;
	const ownArmVolume = (recipients: number, share: number): number => Math.ceil(recipients * share);

	// Normalize the anchor ONCE, here at the boundary: a hostile or stale
	// `startsAt` (NaN, a timestamp in the past) collapses to `now`, so neither
	// the projection nor the pure planner has to defend against it.
	const requestedStart = options.startsAt;
	const startsAt =
		requestedStart !== undefined && Number.isFinite(requestedStart)
			? Math.max(options.now, requestedStart)
			: options.now;
	// THE SAME PACED PROJECTION THE WALKER METERS AGAINST
	// (`delivery/pacedWarmingCapacity.ts`). Reading the UNDIALED projection here
	// would let this gate bless a plan the dialed walker cannot finish inside the
	// retention horizon — the exact failure the multi-day plan exists to prevent.
	const projection = await loadPacedWarmingCapacity(ctx, { now: options.now, startsAt });
	if (projection === null) {
		return { capacityKnown: false, fits: true, unknownReason: 'no_projection' };
	}
	const remainingCapacityByDay = projection.byDay;

	// The projection stops at the last day it can BOUND: schedule day 30 removes
	// the warming cap altogether, and clamping that to a display sentinel would
	// make the array a LOWER bound and let the gate refuse a campaign that fits.
	// If it does not reach across the retention horizon, capacity inside that
	// horizon is unbounded — unknown, and unknown allows.
	if (remainingCapacityByDay.length < usableDayCount(startsAt, GOVERNED_MTA_MAX_MESSAGE_AGE_MS)) {
		return { capacityKnown: false, fits: true, unknownReason: 'projection_shorter_than_horizon' };
	}

	const counted = await countAudience(ctx, options.audience, {
		ceiling: audienceCountCeiling(
			totalPlannableCapacity(remainingCapacityByDay),
			capVerdict.ownArmShare
		),
		documentBudget: AUDIENCE_DOCUMENT_BUDGET,
	});

	// The suppression set could not be read in full, so candidates were filtered
	// through a SUBSET of the blocklist and `eligible` is an OVER-count. Unlike a
	// spent read budget it bounds the audience in NEITHER direction, so it cannot
	// license a refusal — it is simply "unmeasured".
	if (counted.completeness === 'suppression_truncated') {
		return { capacityKnown: false, fits: true, unknownReason: 'audience_over_counted' };
	}

	const planFor = (share: number): CampaignCapacityPlan =>
		planCampaignCapacity({
			// `eligible` is a lower bound whenever the count did not run to
			// completion, and refusing on a lower bound is sound: a bigger audience
			// fits even less well.
			audienceSize: ownArmVolume(counted.eligible, share),
			remainingCapacityByDay,
			maxMessageAgeMs: GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
			now: startsAt,
		});

	const boundsDiffer = ownArmPeak > ownArmFloor;
	const floorVerdict = assessCountedPlan(planFor(ownArmFloor), {
		completeness: counted.completeness,
	});

	// THE FLOOR DECIDES THE REFUSAL, THE PEAK DECIDES THE APPROVAL. A measured
	// "it fits" off the floor is not yet an approval: with the peak over the
	// horizon, whether this campaign's tail expires depends on how its recipients
	// fall across the ramp cells, and nobody has counted that. Saying
	// `capacityKnown: true` there would be the P0-5 tail-expiry itself, dressed as
	// a measurement. A refusal, and an already-unmeasured count, both stand as
	// they are — the peak can only ever turn "it fits" into "unmeasured".
	if (
		floorVerdict.capacityKnown &&
		floorVerdict.fits &&
		boundsDiffer &&
		!planFor(ownArmPeak).fits
	) {
		return { capacityKnown: false, fits: true, unknownReason: 'mix_composition_unknown' };
	}
	if (floorVerdict.capacityKnown && !floorVerdict.fits) {
		return {
			capacityKnown: true,
			fits: false,
			schedule: quotedRefusalSchedule({
				ownArmSchedule: floorVerdict.schedule,
				// THE WALKER'S OWN PLAN, built the way the walker builds it
				// (`multiDaySendPlan.planTodaysSlice` → `buildCapacitySchedule` over the
				// remaining RECIPIENTS against this same projection). Anchored at
				// `startsAt` because that is when the walk begins.
				walkerSchedule: buildCapacitySchedule({
					audienceSize: counted.eligible,
					remainingCapacityByDay,
					now: startsAt,
				}),
				audienceUnderCounted: counted.completeness !== 'exact',
			}),
		};
	}
	return floorVerdict;
}

/**
 * THE SCHEDULE THE OPERATOR IS SHOWN — denominated in RECIPIENTS, because that
 * is what the copy calls it ("N recipients", "everyone is reached by <date>")
 * and what the actuator paces.
 *
 * The refusal is DECIDED on own-arm volume: only the own MTA's traffic meets the
 * warming cap, so `floor x audience` is the number that can prove a campaign's
 * tail expires. It is not the number anyone sends. The walker meters the WHOLE
 * audience through the same day budget (`campaigns/sendPlanQueries.ts`), so a
 * schedule enumerated over own-arm MESSAGES quotes about `share` of the days the
 * send really takes and labels message counts as recipients — under a 5% share,
 * "about 5 days, everyone reached by Friday" for a walk that runs into the
 * following month. Quoting the walker's plan instead makes the two agree by
 * construction, at every share; at `share === 1` they are the same array.
 *
 * `audienceUnderCounted` therefore tracks ONE fact — the count stopped short, so
 * the recipient total is a floor and the day count with it. Own-arm bounds that
 * differ no longer widen the quoted plan: the mix decides whether the cap can
 * strand the campaign, and nothing about how long the walker takes.
 *
 * THE `days === 0` FALLBACK. The projection can plateau at zero after covering
 * the own arm's share but before covering the audience — the planner's "no
 * schedule reaches everyone" sentinel, which callers must never render as a
 * finish. The proven refusal stands on the own-arm plan there, quoted as the
 * lower bound it is: its slices are `min(capacity, own-arm remaining)`, at or
 * below the recipients each day really carries.
 */
export function quotedRefusalSchedule(options: {
	ownArmSchedule: CampaignCapacitySchedule;
	walkerSchedule: CampaignCapacitySchedule;
	audienceUnderCounted: boolean;
}): CampaignCapacitySchedule {
	const { ownArmSchedule, walkerSchedule, audienceUnderCounted } = options;
	if (walkerSchedule.days === 0) return { ...ownArmSchedule, audienceUnderCounted: true };
	return { ...walkerSchedule, audienceUnderCounted };
}

/**
 * CANDIDATE CEILING for the audience count, stated in RECIPIENTS. Pure, and
 * exported so the scaling is pinned directly rather than inferred from a verdict
 * two layers up.
 *
 * The verdict is decided once own-arm volume exceeds everything the deployment
 * could send across the whole plan window, so the count stops there rather than
 * streaming an unbounded audience inside a send mutation. A split route has to
 * count `1/share` as many RECIPIENTS before the own arm's volume reaches that
 * capacity, which is what keeps a REFUSAL reachable under a low share.
 *
 * The share that sets it is the FLOOR, whose threshold is the later of the two —
 * except at a floor of ZERO, where no count can ever produce a refusal and the
 * division has no answer: there the PEAK's threshold is the point past which the
 * verdict is "unmeasured" however many more recipients turn up. A binding
 * verdict always has a positive peak.
 *
 * WHAT ACTUALLY STOPS THE SCAN IS USUALLY NOT THIS. `countAudience` clamps the
 * request to `COUNT_CEILING` (25,000) and `AUDIENCE_DOCUMENT_BUDGET` stops the
 * stream at 6,000 documents — at least one per candidate — so on the shipped
 * warming projections (a single day-1 IP already plans past a million) this
 * ceiling never binds, and it is the document budget that ends the count. It
 * binds only on a projection paced far down. Either way a stopped count cannot
 * fake a measurement: it reads `candidate_capped` / `read_budget_exhausted`, and
 * {@link assessCountedPlan} refuses to license "it fits" from one.
 */
export function audienceCountCeiling(
	totalCapacity: number,
	ownArmShare: OwnArmShareBounds
): number {
	const countingShare = ownArmShare.floor > 0 ? ownArmShare.floor : ownArmShare.peak;
	return Math.ceil((totalCapacity + 1) / countingShare);
}

/**
 * The assessment for ONE counted audience, from the plan built over the volume
 * the own arm is GUARANTEED to carry. Pure, and exported because the count
 * completeness that reaches it cannot be seeded through the binding path — the
 * candidate ceiling sits at 25,001 recipients and the document budget stops the
 * scan thousands of rows earlier.
 *
 * THE TWO SIDES ARE NOT SYMMETRIC.
 *
 *  - A plan that does NOT fit is a sound refusal on any lower bound: the real
 *    audience can only be bigger, so it fits even less well.
 *  - A plan that fits is a MEASUREMENT only when the count was exact. "At least
 *    N recipients fit" says nothing about the audience behind the N, and calling
 *    it `capacityKnown: true` is precisely how a 2M-contact audience gets blessed
 *    off a count that stopped at 25,000. It is unmeasured — which still ALLOWS
 *    (D2), and says why.
 *
 * `suppression_truncated` is excluded by TYPE rather than by branch: an
 * over-count bounds the audience in neither direction, so it may not license
 * even the refusal side, and its caller has to have discharged it before it can
 * reach here.
 *
 * THE SCHEDULE IT RETURNS IS IN OWN-ARM MESSAGES, and is the DECISION's plan —
 * `measureCampaignCapacity` re-denominates it into the recipients the operator
 * is quoted (see {@link quotedRefusalSchedule}) before it leaves this module.
 */
export function assessCountedPlan(
	plan: CampaignCapacityPlan,
	options: {
		completeness: Exclude<AudienceCountCompleteness, 'suppression_truncated'>;
	}
): CampaignCapacityAssessment {
	if (plan.fits) {
		if (options.completeness === 'exact') return { capacityKnown: true, fits: true };
		return { capacityKnown: false, fits: true, unknownReason: 'audience_under_counted' };
	}
	return toAssessment(plan, { audienceUnderCounted: options.completeness !== 'exact' });
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
	if (plan.days === 0) {
		return { capacityKnown: false, fits: true, unknownReason: 'unplannable_projection' };
	}
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
 *
 * `fromEmail` is REQUIRED even though the assessment tolerates its absence. The
 * From-domain is what decides whether warm-up overflow to a verified relay can
 * absorb the tail, so omitting it yields the conservative answer — the preview
 * would quote "Sending over N days" for a send the binding gate then lets
 * through in one go. The preview and the gate must never give the operator two
 * different answers; pre-flight already refuses `no_from_email` before ever
 * reaching the capacity check, so the wizard always has the address by the time
 * it can preview a plan.
 */
// all-members: deployment-wide sending capacity is not per-user data — it is the
// same warming projection every delivery screen already renders to any member,
// and the caller supplies the audience it is about to preview. No row is read
// that a member cannot already read through countRecipients / the warming pages.
export const getCampaignCapacityPlan = authedQuery({
	args: {
		audience: v.optional(audienceValidator),
		fromEmail: v.string(),
		startsAt: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<CampaignCapacityAssessment> => {
		if (!args.audience) {
			return { capacityKnown: false, fits: true, unknownReason: 'no_audience' };
		}
		return await assessCampaignCapacity(ctx, {
			audience: args.audience,
			fromEmail: args.fromEmail,
			now: Date.now(),
			...(args.startsAt !== undefined ? { startsAt: args.startsAt } : {}),
		});
	},
});
