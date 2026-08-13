/**
 * SENDING READINESS — the ramp cap, quoted where the operator acts.
 *
 * `capacityPreflight.ts` answers "can THIS audience finish inside the retention
 * horizon", and it answers it with a refusal or a multi-day schedule. That is
 * the right answer at the moment of sending and the wrong one before it: an
 * operator who has not chosen an audience yet — or who is looking at the
 * getting-started checklist — has no schedule to be shown, and discovering the
 * warming cap as a pre-flight refusal is exactly the surprise the deliverability
 * plan's D14 forbids.
 *
 * So this module answers the smaller, earlier question: how much can go out
 * TODAY, and when does that number grow. Same paced projection as the binding
 * gate and the multi-day walker (`delivery/pacedWarmingCapacity.ts`), same
 * warming-cap verdict (`lib/sendProviders/warmingCapGate.ts`) — one projection,
 * one answer, so a readiness line can never contradict the gate that follows it.
 *
 * NEVER REFUSES, NEVER GUESSES. Every measurement fault degrades to "the cap
 * does not bind / we cannot measure it" and the UI renders nothing rather than a
 * number it cannot stand behind.
 */

import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { loadPacedWarmingCapacity } from '../delivery/pacedWarmingCapacity';
import type { WarmingCapacityProjection } from '../delivery/warmingCapacity';
import { campaignWarmingCapBinds } from '../lib/sendProviders/warmingCapGate';
import { MS_PER_DAY } from '../lib/constants';
import { utcDayStart } from '../lib/utcDay';
import { logWarn } from '../lib/runtimeLog';
import type { CapacityUnknownReason } from './capacityPreflight';

type Ctx = MutationCtx | QueryCtx;

/**
 * Why no cap is being quoted. A subset of the pre-flight assessment's
 * {@link CapacityUnknownReason}s, drawn from that type rather than restated so
 * the two surfaces can never disagree about what a reason means.
 *
 * The first two are reassurance ("nothing is capping this send"); the rest are
 * genuine measurement faults, where the honest UI is silence.
 */
export type SendingReadinessUncappedReason = Extract<
	CapacityUnknownReason,
	'warmup_overflow_absorbs' | 'not_own_mta' | 'dispatch_unknown' | 'no_projection'
>;

/**
 * How much campaign volume can go out today, and when the cap next grows.
 *
 * A discriminated union so "we are quoting a cap" and "we are not" cannot be
 * confused: an uncapped answer carries NO number, which is what stops a UI from
 * rendering "about 0 contacts today" for a deployment that has no cap at all.
 */
export type SendingReadiness =
	| { capped: false; reason: SendingReadinessUncappedReason | 'measurement_failed' }
	| {
			capped: true;
			/** Campaign volume still sendable today, at the pace the walker meters. */
			today: number;
			/**
			 * The next projected day that carries MORE than today's remainder, and
			 * how much — `null` when the projection never grows past today inside its
			 * window (a plateaued ramp, or a day whose remainder already exceeds every
			 * projected day). Quoting a growth that is not there would promise
			 * headroom the walker will not have.
			 */
			growsTo: number | null;
			/** UTC start of the day `growsTo` applies to. Set iff `growsTo` is. */
			growsAt: number | null;
	  };

/** Non-negative finite integer, or 0 for anything hostile (NaN, -1, Infinity). */
function sanitizeCount(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

/**
 * Reduce a paced projection to the two numbers a readiness line needs. Pure, so
 * the "when does it grow" walk is table-testable without seeding warming state.
 *
 * `remainingToday` rather than `byDay[0]` for today: they are the same number
 * for a send starting today, and `remainingToday` stays correct for a projection
 * anchored on a future start (`delivery/warmingCapacity.ts` documents the
 * difference). Growth is searched from day 1 — day 0 is a PARTIAL day, so a full
 * projected day being larger than it is not news unless it is larger than what
 * is actually left today, which is exactly the comparison below.
 */
export function summarizeProjectedCapacity(
	projection: WarmingCapacityProjection,
	now: number
): Extract<SendingReadiness, { capped: true }> {
	const today = sanitizeCount(projection.remainingToday);
	const dayZero = utcDayStart(now);
	for (let day = 1; day < projection.byDay.length; day += 1) {
		const capacity = sanitizeCount(projection.byDay[day] ?? 0);
		if (capacity > today) {
			return { capped: true, today, growsTo: capacity, growsAt: dayZero + day * MS_PER_DAY };
		}
	}
	return { capped: true, today, growsTo: null, growsAt: null };
}

async function measureSendingReadiness(
	ctx: Ctx,
	fromEmail: string | undefined,
	now: number
): Promise<SendingReadiness> {
	// Does the own-MTA warming cap bind this deployment's campaign traffic at
	// all? Asked FIRST and exactly as the binding gate asks it: warm-up overflow
	// to a verified relay, or a campaign route that never touches the own MTA,
	// means there is no cap to quote and saying otherwise would invent a limit.
	const verdict = await campaignWarmingCapBinds(ctx, { fromEmail, now });
	if (!verdict.binds) return { capped: false, reason: verdict.why };

	const projection = await loadPacedWarmingCapacity(ctx, { now });
	if (projection === null) return { capped: false, reason: 'no_projection' };

	// THE NUMBER IS OWN-MTA VOLUME, and under a split route (`adaptive_mix`) only
	// the own arm's share of an audience meets the cap — so the quoted figure is
	// then a FLOOR on the contacts reachable today, never a ceiling. Scaling it up
	// by `1 / share` would be the over-claim: nobody has counted how this
	// audience falls across the ramp cells (see `warmingCapGate.ts`), and a
	// readiness line that promises more than the walker delivers is worse than one
	// that promises less.
	return summarizeProjectedCapacity(projection, now);
}

/**
 * The measurement, FAIL-QUIET. This renders beside a send button; an exception
 * escaping here would break the page that sends mail over a readout that is
 * advisory by construction, so every fault degrades to "no cap to quote".
 *
 * Separate from the query so the catch arm is reachable in a test: a query's
 * handler cannot be handed a context whose reads throw, and an arm that
 * guarantees a measurement fault can never break the send page is exactly the
 * one that must be proven rather than assumed (the same seam
 * `assessCampaignCapacity` keeps for the pre-flight's fail-open).
 */
export async function readSendingReadiness(
	ctx: Ctx,
	fromEmail: string | undefined,
	now: number
): Promise<SendingReadiness> {
	try {
		return await measureSendingReadiness(ctx, fromEmail, now);
	} catch (err) {
		logWarn('sendingReadiness: capacity could not be measured', err);
		return { capped: false, reason: 'measurement_failed' };
	}
}

/**
 * Today's sending headroom, for the surfaces that have to say it BEFORE the send
 * button: the campaign send/schedule flow and the getting-started checklist.
 *
 * `fromEmail` is optional here — unlike `getCampaignCapacityPlan`, which needs it
 * to answer the same question the gate will. Omitting it yields the CONSERVATIVE
 * answer: the From-domain is what proves warm-up overflow can absorb the tail, so
 * without it the cap is quoted even where a verified relay would have absorbed
 * it. That is the most a surface with no chosen sender (the checklist) can
 * honestly say, and it under-promises rather than over-promises. Every surface
 * that HAS an address passes it and gets the gate's own verdict.
 */
// all-members: deployment-wide sending capacity is not per-user data — it is the
// same warming projection the delivery pages and the campaign capacity preview
// already render to any member, with no per-recipient or credential data in it.
export const getSendingReadiness = authedQuery({
	args: { fromEmail: v.optional(v.string()) },
	handler: async (ctx, args): Promise<SendingReadiness> =>
		await readSendingReadiness(ctx, args.fromEmail, Date.now()),
});
