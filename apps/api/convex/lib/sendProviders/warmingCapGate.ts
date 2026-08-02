/**
 * Campaign warming-cap gate (read seam).
 *
 * One question, asked by the P0-5 binding capacity pre-flight: does the own
 * MTA's per-IP warming cap actually BIND this deployment's campaign traffic?
 * It reads route state, so it lives beside `route.ts` rather than in the gate
 * — and it is its own module because answering it means combining the shipped
 * route resolution with the relay-identity proof, which is a distinct concern
 * from resolving where a single message goes.
 *
 * WHAT THIS SEAM CANNOT DO, said out loud (D14). The stream's own-arm FLOOR is
 * zero as soon as ONE cell carries nothing on the own MTA — a stored share of 0,
 * or (see {@link campaignStreamShare}) a fresh actionable signal that the
 * dispatch path relays or defers the whole cell on — and a zero floor can never
 * refuse anything, because a lower bound of zero on own-arm volume exceeds no
 * capacity.
 * In a ramping deployment at least one such cell is ordinary, so P0-5's REFUSAL
 * is unenforceable here most of the time: a campaign whose recipients all sit in
 * un-degraded cells is answered "capacity unknown, allowed", and its tail can
 * still expire at `maxMessageAgeMs`. The PEAK keeps the approval side honest
 * there — a campaign that fits at the peak is measured, not merely waved through
 * — but nothing recovers the refusal short of counting the audience BY CELL,
 * i.e. the denormalized audience counter the `COUNT_CEILING` follow-up names,
 * extended to a per-cell histogram. Until then this gate binds a warming
 * deployment whose cells are all un-degraded, which is the configuration P0-5
 * was written for.
 *
 * AND WHAT IT ANSWERS ABOUT A CAMPAIGN IT DOES NOT ACTUATE. The share carried
 * back here scales the PRE-FLIGHT's measurement only. The multi-day send walker
 * and the wizard's day estimate meter the whole audience against the same paced
 * projection, so under `adaptive_mix` they quote a longer plan than this gate
 * measured; `campaigns/sendPlanQueries.ts` states which answer is authoritative
 * and what closes the gap.
 */

import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { SendRouteFacts } from './route';
import { loadSendRouteFacts, routingDeferralCode, selectRouteFromFacts } from './route';
import { freshFallbackReasons, isGlobalBreakerOpenState } from './routeInputs';
import { relayDomainVerified } from './relayDomainVerification';
import type { ResolvedRoute } from './routing';
import { OWN_ARM_TRANSPORT_KIND } from './strategies/adaptive_mix';
import { isSendProviderKind, type SendProviderKind } from './types';
import { extractDomainOrNull, extractOperationError } from '@owlat/shared';
import {
	DESTINATION_PROVIDER_KEYS,
	OWN_SHARE_CEILING,
	OWN_SHARE_FLOOR,
} from '@owlat/shared/deliverabilityRouting';
import {
	EMPTY_ROUTE_STATE_CELL,
	loadStreamRouteStateCells,
	loadStreamlessRouteState,
	mixCellStateFor,
} from '../deliverabilityRouteState';
import { getSingletonOrganizationId } from '../sessionOrganization';

/**
 * The base (pre-deliverability) campaign resolution from ONE pass over the
 * route tables: the route row, the readiness set, and the route the shipped
 * resolver selected — or `route: null` when it cannot select one.
 *
 * `resolveRoute` signals an unusable relay configuration by throwing. That is
 * not a failure to report here, but it also must NOT collapse the whole
 * resolution: the facts it threw over — which providers are configured, enabled
 * and ready — are exactly what `campaignDispatchSurface` decides from under the
 * traffic-splitting strategies, and they are already read. Losing them was the
 * source of the non-deterministic verdict: under `workload_split` the throw
 * fires only on the draws where the weighted selector happened to land on the
 * relay entry.
 */
async function resolveCampaignBase(
	ctx: QueryCtx | MutationCtx
): Promise<SendRouteFacts & { route: ResolvedRoute | null }> {
	const facts = await loadSendRouteFacts(ctx, 'campaign');
	try {
		return { ...facts, route: selectRouteFromFacts(facts, 'campaign', undefined) };
	} catch (error) {
		if (routingDeferralCode(error)) return { ...facts, route: null };
		throw error;
	}
}

/**
 * Why the own-MTA warming cap does NOT bind this deployment's campaign
 * traffic. A verdict, not a footnote: it is what the "capacity unknown" arm of
 * the pre-flight assessment renders as its measurement-confidence reason
 * (plan D12 — every decision carries a recorded reason; D14 — say the quiet
 * part), and the three cases are materially different things to tell an
 * operator.
 */
export type WarmingCapNotBindingReason =
	/**
	 * Warm-up overflow to a VERIFIED relay will absorb the tail. Capacity is
	 * genuinely not a constraint on this send — nothing to improve.
	 */
	| 'warmup_overflow_absorbs'
	/**
	 * Campaign traffic does not dispatch through the own MTA at all, so the
	 * per-IP warming cap is not an upper bound on this campaign. Also not a
	 * constraint — but for a different reason, and the operator's own-MTA
	 * warm-up progress says nothing about this send.
	 */
	| 'not_own_mta'
	/**
	 * Nothing is known about where campaigns dispatch: no enabled+ready route
	 * entry AND no resolvable base route. This is genuinely MISSING DATA — the
	 * send is allowed (D10: never act on thin data), but unlike the other two
	 * this one is worth surfacing as low measurement confidence rather than as
	 * reassurance.
	 */
	| 'dispatch_unknown';

/**
 * How much of an audience the own arm carries, bounded on BOTH sides.
 *
 * Own-arm volume is `sum over cells of share_c x audience_c`, and nobody has
 * counted this audience by cell, so the two bounds are not interchangeable and
 * neither one decides alone: only the floor may license a refusal, only the peak
 * may license "it fits", and an audience between them is unmeasured.
 */
export interface OwnArmShareBounds {
	/**
	 * The smallest own-arm share any cell of the stream carries — the LOWER bound
	 * on own-arm volume, whatever the audience's per-cell composition turns out
	 * to be. Zero whenever ANY cell is fully off the own arm, by a stored share of
	 * zero, by a fresh actionable signal the escape hatch relays on, or by the
	 * pool-wide circuit deferring the whole stream — which is why a refusal is
	 * often unavailable (see the module doc).
	 */
	readonly floor: number;
	/**
	 * The largest — the UPPER bound, and the only one an "it fits" answer may be
	 * derived from.
	 */
	readonly peak: number;
}

/** Does the own-MTA warming cap bind campaign traffic, and if not, why not. */
export type WarmingCapVerdict =
	| {
			binds: true;
			/**
			 * How much of the audience the own MTA has to carry, so the caller
			 * measures the warming projection against the traffic that is actually
			 * subject to the cap rather than against the whole audience.
			 *
			 * Both bounds are `OWN_SHARE_CEILING` (1) for every strategy that puts a
			 * whole audience on one transport — which is every shipped strategy — and
			 * under `adaptive_mix` they are the extremes over the stream's cells (see
			 * {@link campaignStreamShare}). THE PEAK is always greater than zero: an
			 * own arm carrying nothing ANYWHERE is not a binding verdict, it is
			 * `not_own_mta`. The floor may well be zero, and a binding verdict with a
			 * zero floor still says something — it just says only "at most this much
			 * meets the cap", never "at least".
			 */
			ownArmShare: OwnArmShareBounds;
	  }
	| { binds: false; why: WarmingCapNotBindingReason };

/**
 * The own arm's share of the campaign stream, or why the cap does not bind at
 * all — the two halves of the verdict that the dispatch surface decides, before
 * warm-up overflow is considered.
 */
type CampaignDispatch = { ownArmShare: OwnArmShareBounds } | { why: WarmingCapNotBindingReason };

/**
 * Every strategy that puts a WHOLE audience on ONE transport: both bounds
 * coincide at the ceiling and the caller's two decisions collapse into one.
 */
const WHOLE_AUDIENCE_SHARE: OwnArmShareBounds = Object.freeze({
	floor: OWN_SHARE_CEILING,
	peak: OWN_SHARE_CEILING,
});

/**
 * The own arm's share bounds across the campaign stream's cells, or `null` when
 * this deployment has no organization to resolve cells for.
 *
 * BOTH BOUNDS, BECAUSE NEITHER DECIDES ALONE. Own-arm volume is
 * `sum over cells of share_c x audience_c`, and this gate judges an AUDIENCE,
 * not a recipient: the per-cell composition is only knowable by counting it, at
 * a cost the send mutation cannot pay. So the minimum share over the cells
 * bounds that volume from below — at least `floor x audience` messages must go
 * through the own MTA, which is what makes a refusal sound — and the maximum
 * bounds it from above, which is what makes an APPROVAL sound. Carrying only
 * the floor would let the gate assert "it fits" on a campaign whose recipients
 * all sit in the cells the own MTA still carries whole; a mean would be unsound
 * in both directions.
 *
 * A cell with no rows resolves to `OWN_SHARE_CEILING`: the un-migrated default,
 * where the own MTA carries the whole cell.
 *
 * THE STORED SHARE IS NOT THE WHOLE FLOOR. `resolveOwnShare` reads
 * `perStream ?? streamless`, so a controller row carrying 0.9 answers 0.9 even
 * while the MTA snapshot's row for the same cell carries a fresh `dnsbl_listed`
 * or `breaker_open` verdict — and the dispatch path does NOT split that cell 90
 * / 10. `cellRoute` feeds those signals to `resolveRoute` as `activeReasons`,
 * and one active reason overrides the strategy outright (routing.ts): with the
 * escape hatch enabled the whole cell relays, and where the relay proof is
 * missing it defers instead. Neither outcome is own-MTA volume, so the cell's
 * guaranteed lower bound is ZERO, and reading 0.9 would over-count own-arm
 * volume in the direction that REFUSES — the false blocker D2 forbids. The
 * reasons are therefore recomputed per cell from the rows already scanned, and
 * only while the escape hatch is on: with it off the reason is inert
 * (`resolveRoute` returns the strategy's selection) and the stored share is the
 * whole answer.
 *
 * THE POOL-WIDE BREAKER IS NOT A HATCH DECISION. A fresh `breaker_open` on the
 * `'all'` row DEFERS the whole stream rather than relaying it, and it does so
 * hatch on or hatch off: `cellRoute` short-circuits every cell to `null` before
 * `resolveRoute` is reached, and `resolveRoute` throws
 * `GlobalDeliveryCircuitOpenError` on its first line, before
 * `deliverabilityFallback` is consulted. A deferred message is not own-MTA
 * volume either, so every cell's guaranteed lower bound is zero with the hatch
 * off too — and `applySnapshot` writes that row whatever the hatch says, so
 * keeping the stored shares there would over-count own-arm volume in the
 * direction that REFUSES: a multi-day refusal quoted to a campaign that ships as
 * soon as the transient circuit closes. Hence one unconditional read of the row
 * and a floor condition with no hatch term.
 *
 * ONLY THE FLOOR IS CORRECTED. Over-estimating the PEAK can only turn "it fits"
 * into "unmeasured", which allows either way, so it stays the plain share
 * extreme.
 *
 * READS A WHOLE-ORGANIZATION RANGE, inside a send mutation: the OCC footprint
 * that buys is stated on `loadStreamRouteStateCells` (D16). A gate judging an
 * AUDIENCE has no single cell to point-read, so the range is what the question
 * costs. The pool-wide `'all'` row is one extra point read on top.
 */
async function campaignStreamShare(
	ctx: QueryCtx | MutationCtx,
	options: { now: number; isEscapeHatchEnabled: boolean }
): Promise<OwnArmShareBounds | null> {
	let organizationId: string;
	try {
		organizationId = await getSingletonOrganizationId(ctx);
	} catch (error) {
		// ONLY "this deployment has no single organization" — a `forbidden` throw —
		// reads as "no tenant", and that case is benign: with no tenant there is no
		// mix context at dispatch either (`mixContextFor` returns undefined), so
		// `adaptive_mix` selects nothing and the resolver's env fallback is what
		// actually carries the campaign. The caller then reads the verdict off the
		// base route, exactly as it does for a deterministic strategy.
		//
		// A TRANSIENT FAILURE OF THE COMPONENT READ IS NOT THAT. Swallowing it here
		// would hand the whole campaign verdict back to `EMAIL_PROVIDER` — the
		// reading this module exists to remove — and it would be indistinguishable
		// from an unconfigured deployment. It propagates instead, and the
		// pre-flight's fail-open records it as `measurement_failed`: capacity
		// unmeasured, send allowed, and said out loud (D12).
		if (extractOperationError(error)?.category !== 'forbidden') throw error;
		return null;
	}
	const [cells, globalState] = await Promise.all([
		loadStreamRouteStateCells(ctx, organizationId, 'campaign'),
		loadStreamlessRouteState(ctx, organizationId, 'all'),
	]);
	// The circuit is read before the hatch on both dispatch paths, so it zeroes
	// every cell's floor on its own.
	const isDeferredPoolWide = isGlobalBreakerOpenState(globalState, options.now);
	let floor = OWN_SHARE_CEILING;
	let peak = OWN_SHARE_FLOOR;
	for (const provider of DESTINATION_PROVIDER_KEYS) {
		const cell = cells.get(provider) ?? EMPTY_ROUTE_STATE_CELL;
		const { ownShare } = mixCellStateFor(cell);
		peak = Math.max(peak, ownShare);
		// EVERY row a routing decision keys off, in the order `cellRoute` passes
		// them: the pool-wide row, the cell's infrastructure row and the
		// controller's own. Any one of them may hold the fresh actionable verdict,
		// and the pool-wide row carries non-breaker verdicts too.
		const isRelayedByReason =
			options.isEscapeHatchEnabled &&
			freshFallbackReasons([globalState, cell.streamless, cell.perStream], options.now).length > 0;
		floor = Math.min(floor, isDeferredPoolWide || isRelayedByReason ? OWN_SHARE_FLOOR : ownShare);
	}
	return { floor, peak };
}

/**
 * The `adaptive_mix` verdict, read off the MIX rather than off the selected
 * route — the selected route is a function of the RECIPIENT, and this gate has
 * none.
 */
function adaptiveMixDispatch(
	enabledKinds: readonly SendProviderKind[],
	share: OwnArmShareBounds
): CampaignDispatch {
	// The own arm has to be a dispatch path at all: with no enabled+ready MTA
	// entry, `adaptiveMixStrategy` sends even an own-arm decision to the
	// reference transport, so no campaign byte meets the cap.
	if (!enabledKinds.includes(OWN_ARM_TRANSPORT_KIND)) return { why: 'not_own_mta' };
	// ONE ARM CONFIGURED IS NOT A MIX. With no reference transport enabled+ready
	// the strategy's additive-only rule (D2) sends the whole cell on the own MTA
	// however low the stored share is, so the cap binds against ALL of it.
	if (enabledKinds.every((kind) => kind === OWN_ARM_TRANSPORT_KIND)) {
		return { ownArmShare: WHOLE_AUDIENCE_SHARE };
	}
	// A PEAK of zero means no cell dispatches on the own MTA at all: the cap
	// cannot strand this campaign whatever its composition. Any peak above it
	// binds — including one whose floor is zero, which is the mixed case where
	// some cells are fully relayed and some are not. That verdict cannot refuse
	// (a zero lower bound exceeds no capacity), but it still bounds the campaign
	// from above, which is exactly what separates "it fits" from "nobody has
	// counted this audience by cell".
	if (share.peak === OWN_SHARE_FLOOR) return { why: 'not_own_mta' };
	return { ownArmShare: share };
}

/**
 * WHICH TRANSPORTS CARRY THIS CAMPAIGN, and how much of it the own arm carries.
 *
 * WHAT COUNTS AS "on the own MTA" DEPENDS ON THE STRATEGY, and so does WHAT THE
 * ANSWER MAY BE DERIVED FROM.
 *
 * `workload_split` selects among the enabled+ready entries by WEIGHTED RANDOM
 * draw (strategies/workload_split), so the selected route is not a function of
 * the configuration and must never be consulted here: the preview query and the
 * binding gate are separate calls that would otherwise quote the operator two
 * different answers. Under this strategy EVERY enabled+ready entry carries a
 * share of the audience — including a relay entry that also serves as the
 * deliverability escape hatch — so the verdict is read off the enabled+ready
 * KIND SET alone, and one non-MTA entry is enough to let part of the audience
 * bypass the cap.
 *
 * `adaptive_mix` selects per RECIPIENT from the cell's controlled share, and
 * this gate has no recipient: with no mix context the strategy deliberately
 * answers null (strategies/adaptive_mix), the resolver falls through to the
 * `EMAIL_PROVIDER` env default, and `baseRoute` then names whatever that env var
 * happens to say — which is not where this campaign dispatches. The verdict is
 * therefore read off the MIX (`campaignStreamShare`), and the own arm's share of
 * it travels back with the verdict so the capacity projection is measured
 * against the traffic that actually meets the cap. The env fallback IS consulted
 * for the two configurations where it genuinely governs: no enabled+ready entry
 * for the strategy to select among, and no resolvable tenant (which leaves the
 * dispatch path with no mix context either).
 *
 * `single` (first enabled entry) and `priority_failover` (deterministic order)
 * select deterministically, and there a second provider is a HEALTH failover
 * rather than a traffic split: with the MTA selected and healthy, 100% of
 * campaign traffic still goes through it and the cap binds exactly as this gate
 * describes. Those strategies therefore ask the SHIPPED resolution which base
 * provider is actually selected, rather than re-deriving it.
 */
async function campaignDispatchSurface(
	ctx: QueryCtx | MutationCtx,
	input: {
		strategy: string | undefined;
		enabledKinds: readonly SendProviderKind[];
		baseRoute: ResolvedRoute | null;
		/**
		 * Is `deliverabilityFallback` on? It decides whether a cell's fresh
		 * actionable signal takes traffic off the own arm at all — see
		 * {@link campaignStreamShare}.
		 */
		isEscapeHatchEnabled: boolean;
		now: number;
	}
): Promise<CampaignDispatch> {
	if (input.strategy === 'workload_split') {
		// DECIDE FROM THE CONFIGURATION, NEVER FROM THE SELECTED ROUTE. The
		// weighted-random selector makes `baseRoute` a coin flip under this
		// strategy, and the whole enabled+ready set is the dispatch surface.
		//
		// No usable route entry at all: `resolveRoute` has ALREADY fallen through
		// to the `EMAIL_PROVIDER` env default, so the resolved base route names
		// the kind campaigns dispatch through — reading the env again would be a
		// second place the two answers can disagree. That fallback is itself
		// deterministic (`fallback()` in routing.ts ignores the strategy), so
		// consulting `baseRoute` is sound in exactly this case.
		if (input.enabledKinds.length > 0) {
			return input.enabledKinds.every((kind) => kind === OWN_ARM_TRANSPORT_KIND)
				? { ownArmShare: WHOLE_AUDIENCE_SHARE }
				: { why: 'not_own_mta' };
		}
	} else if (input.strategy === 'adaptive_mix' && input.enabledKinds.length > 0) {
		const share = await campaignStreamShare(ctx, {
			now: input.now,
			isEscapeHatchEnabled: input.isEscapeHatchEnabled,
		});
		if (share !== null) return adaptiveMixDispatch(input.enabledKinds, share);
	}

	// The deterministic tail, and the env fallback for the two strategies above.
	// With no base route either, nothing is known about where campaigns dispatch:
	// hold and allow (D10).
	if (!input.baseRoute) return { why: 'dispatch_unknown' };
	if (input.baseRoute.providerType !== OWN_ARM_TRANSPORT_KIND) return { why: 'not_own_mta' };
	return { ownArmShare: WHOLE_AUDIENCE_SHARE };
}

/**
 * Does the own-MTA warming cap actually BIND campaign traffic?
 *
 * The P0-5 pre-flight capacity gate exists for ONE shipped configuration: a
 * warming deployment sending campaigns through its own MTA with NO relay to
 * overflow to, where exceeding the per-IP warming cap defers the tail until it
 * expires at `maxMessageAgeMs`. In every other configuration the cap cannot
 * strand a campaign, and a gate that refused anyway would be a false blocker on
 * traffic that ships fine today (plan D2 — never block on a measurement that
 * does not apply). Answering `{ binds: false }` therefore means "not subject to
 * the cap, or unknown → allow", and `why` says WHICH — the three cases are not
 * interchangeable and the caller has to be able to tell them apart.
 *
 * Two shipped configurations answer `binds: false`:
 *
 * (a) WARM-UP OVERFLOW TO A VERIFIED RELAY. With `deliverabilityFallback`
 *     enabled, `isWarmupOverflowEnabled` set and the From-domain verified for
 *     the relay, exceeding the cap routes to the relay
 *     (`deliverabilityReason: 'warmup_overflow'`) instead of deferring, so no
 *     tail ever reaches the expiry deadline.
 *
 * (b) CAMPAIGN TRAFFIC IS NOT ON THE OWN MTA. A deployment whose MTA carries
 *     transactional mail (and so keeps syncing `warmingState`) while campaigns
 *     dispatch through SES/Resend/SMTP has no warming cap on campaign traffic
 *     at all, so the projection is not an upper bound on what the campaign can
 *     send and refusing on it would be unsound.
 *
 *     Which transports carry the campaign — and, under `adaptive_mix`, how much
 *     of it the own arm carries — is decided by `campaignDispatchSurface`.
 *
 * A BINDING verdict carries `ownArmShare`, because "the cap binds" and "the cap
 * binds ALL of it" stopped being the same statement once a cell's traffic could
 * be SPLIT between the arms. The caller measures the warming projection against
 * `share x audience`: quoting a 95%-relayed campaign a multi-day plan computed
 * over its whole audience would be exactly the false blocker D2 forbids. It
 * carries BOTH bounds of that share and the two license different sentences —
 * refuse on the floor, approve on the peak, report the gap as unmeasured — for
 * the reason `campaignStreamShare` states: the composition of the audience
 * across the cells is not known here, and a single number would have to pretend
 * it is.
 *
 * Either way the entries are judged READY, not merely enabled — `resolveRoute`
 * filters route entries through `isSendProviderReady`, so an enabled but
 * credential-less SES entry alongside the MTA is not a route and must not turn
 * this gate off. Readiness comes from `SendRouteFacts.readyKinds`, which is
 * total over the ENABLED entries of `routeConfig.providers` by contract — and
 * the loop below asks it only about enabled entries, so the two agree exactly.
 *
 * Lives here rather than in the gate because this module already owns both
 * reads — the campaign route row and the relay-domain re-verification.
 */
export async function campaignWarmingCapBinds(
	ctx: QueryCtx | MutationCtx,
	options: { fromEmail?: string | undefined; now: number }
): Promise<WarmingCapVerdict> {
	// ONE pass over the route tables.
	const { routeConfig, readyKinds, route: baseRoute } = await resolveCampaignBase(ctx);

	const fallbackConfig = routeConfig?.deliverabilityFallback;
	// Enabled route entries that are also READY — `resolveRoute` filters entries
	// through `isSendProviderReady`, so an enabled but credential-less SES entry
	// alongside the MTA is not a route and must not turn this gate off. The
	// readiness verdicts come from the pass above rather than a second lookup.
	const enabledKinds: SendProviderKind[] = [];
	for (const provider of routeConfig?.providers ?? []) {
		const kind = provider.providerType;
		if (!provider.isEnabled) continue;
		if (!isSendProviderKind(kind)) continue;
		if (!readyKinds.has(kind)) continue;
		enabledKinds.push(kind);
	}

	const dispatch = await campaignDispatchSurface(ctx, {
		strategy: routeConfig?.strategy,
		enabledKinds,
		baseRoute,
		isEscapeHatchEnabled: fallbackConfig?.isEnabled === true,
		now: options.now,
	});
	if ('why' in dispatch) return { binds: false, why: dispatch.why };
	const bindingVerdict: WarmingCapVerdict = { binds: true, ownArmShare: dispatch.ownArmShare };

	// Warm-up overflow needs EVERY link that `resolveRoute` needs before it will
	// relay instead of throwing: the escape hatch on, overflow on, an SES relay,
	// that relay ready and enabled as a route entry, and the From-domain's relay
	// proof still current. Any missing link and the tail defers exactly as it
	// would with no relay at all, so the cap still binds.
	if (
		!fallbackConfig?.isEnabled ||
		!fallbackConfig.isWarmupOverflowEnabled ||
		!enabledKinds.some((kind) => kind === fallbackConfig.relayProviderType)
	) {
		return bindingVerdict;
	}
	const fromDomain = options.fromEmail ? extractDomainOrNull(options.fromEmail) : null;
	if (!fromDomain) return bindingVerdict;
	const overflowAvailable = await relayDomainVerified(
		ctx,
		fromDomain,
		fallbackConfig.relayProviderType,
		options.now
	);
	return overflowAvailable ? { binds: false, why: 'warmup_overflow_absorbs' } : bindingVerdict;
}
