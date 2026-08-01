/**
 * Campaign warming-cap gate (read seam).
 *
 * One question, asked by the P0-5 binding capacity pre-flight: does the own
 * MTA's per-IP warming cap actually BIND this deployment's campaign traffic?
 * It reads route state, so it lives beside `route.ts` rather than in the gate
 * — and it is its own module because answering it means combining the shipped
 * route resolution with the relay-identity proof, which is a distinct concern
 * from resolving where a single message goes.
 */

import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { SendRouteFacts } from './route';
import { loadSendRouteFacts, routingDeferralCode, selectRouteFromFacts } from './route';
import { relayDomainVerified } from './relayDomainVerification';
import type { ResolvedRoute } from './routing';
import { OWN_ARM_TRANSPORT_KIND } from './strategies/adaptive_mix';
import { isSendProviderKind, type SendProviderKind } from './types';
import { extractDomainOrNull } from '@owlat/shared';
import {
	DESTINATION_PROVIDER_KEYS,
	OWN_SHARE_CEILING,
	OWN_SHARE_FLOOR,
} from '@owlat/shared/deliverabilityRouting';
import {
	EMPTY_ROUTE_STATE_CELL,
	loadStreamRouteStateCells,
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

/** Does the own-MTA warming cap bind campaign traffic, and if not, why not. */
export type WarmingCapVerdict =
	| {
			binds: true;
			/**
			 * The fraction of the audience the own MTA has to carry, so the caller
			 * measures the warming projection against the traffic that is actually
			 * subject to the cap rather than against the whole audience.
			 *
			 * `OWN_SHARE_CEILING` (1) for every strategy that puts a whole audience
			 * on one transport — which is every shipped strategy. Under
			 * `adaptive_mix` it is the stream's FLOOR share (see
			 * {@link campaignStreamShare}), the only bound that holds whatever the
			 * audience's per-cell composition turns out to be. ALWAYS GREATER THAN
			 * ZERO: an own arm carrying nothing is not a binding verdict, it is
			 * `not_own_mta`.
			 */
			ownArmShare: number;
	  }
	| { binds: false; why: WarmingCapNotBindingReason };

/**
 * The own arm's share of the campaign stream, or why the cap does not bind at
 * all — the two halves of the verdict that the dispatch surface decides, before
 * warm-up overflow is considered.
 */
type CampaignDispatch = { ownArmShare: number } | { why: WarmingCapNotBindingReason };

/** The own-arm share across a stream's cells: its floor and its peak. */
interface StreamShareBounds {
	/** The smallest own-arm share any cell of the stream carries. */
	floor: number;
	/** The largest — `0` means no cell dispatches on the own MTA at all. */
	peak: number;
}

/**
 * The own arm's share bounds across the campaign stream's cells, or `null` when
 * the tenant cannot be resolved.
 *
 * THE FLOOR, NOT THE MEAN AND NOT THE PEAK. Own-arm volume is
 * `sum over cells of share_c x audience_c`, and this gate judges an AUDIENCE,
 * not a recipient: the per-cell composition is only knowable by counting it, at
 * a cost the send mutation cannot pay. The minimum share over the stream's cells
 * is the one bound that holds for every composition — at least
 * `floor x audience` messages must go through the own MTA — so a refusal
 * derived from it is sound. The peak would refuse campaigns that fit (D2), and
 * a mean would do both.
 *
 * A cell with no rows resolves to `OWN_SHARE_CEILING`: the un-migrated default,
 * where the own MTA carries the whole cell.
 */
async function campaignStreamShare(ctx: QueryCtx | MutationCtx): Promise<StreamShareBounds | null> {
	let organizationId: string;
	try {
		organizationId = await getSingletonOrganizationId(ctx);
	} catch {
		// No resolvable tenant means no mix context at dispatch either
		// (`mixContextFor` returns undefined), so `adaptive_mix` selects nothing
		// and the resolver's env fallback is what actually carries the campaign.
		// The caller then reads the verdict off the base route, exactly as it does
		// for a deterministic strategy.
		return null;
	}
	const cells = await loadStreamRouteStateCells(ctx, organizationId, 'campaign');
	let floor = OWN_SHARE_CEILING;
	let peak = OWN_SHARE_FLOOR;
	for (const provider of DESTINATION_PROVIDER_KEYS) {
		const { ownShare } = mixCellStateFor(cells.get(provider) ?? EMPTY_ROUTE_STATE_CELL);
		floor = Math.min(floor, ownShare);
		peak = Math.max(peak, ownShare);
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
	share: StreamShareBounds
): CampaignDispatch {
	// The own arm has to be a dispatch path at all: with no enabled+ready MTA
	// entry, `adaptiveMixStrategy` sends even an own-arm decision to the
	// reference transport, so no campaign byte meets the cap.
	if (!enabledKinds.includes(OWN_ARM_TRANSPORT_KIND)) return { why: 'not_own_mta' };
	// ONE ARM CONFIGURED IS NOT A MIX. With no reference transport enabled+ready
	// the strategy's additive-only rule (D2) sends the whole cell on the own MTA
	// however low the stored share is, so the cap binds against ALL of it.
	if (enabledKinds.every((kind) => kind === OWN_ARM_TRANSPORT_KIND)) {
		return { ownArmShare: OWN_SHARE_CEILING };
	}
	if (share.floor > OWN_SHARE_FLOOR) return { ownArmShare: share.floor };
	// A floor of zero. Either NO cell dispatches on the own MTA — the cap cannot
	// strand anything — or some do and some do not, in which case how much of
	// this audience meets the cap depends on a composition nobody has counted.
	// The second is missing data, not reassurance, and it is reported as such.
	return { why: share.peak > OWN_SHARE_FLOOR ? 'dispatch_unknown' : 'not_own_mta' };
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
				? { ownArmShare: OWN_SHARE_CEILING }
				: { why: 'not_own_mta' };
		}
	} else if (input.strategy === 'adaptive_mix' && input.enabledKinds.length > 0) {
		const share = await campaignStreamShare(ctx);
		if (share !== null) return adaptiveMixDispatch(input.enabledKinds, share);
	}

	// The deterministic tail, and the env fallback for the two strategies above.
	// With no base route either, nothing is known about where campaigns dispatch:
	// hold and allow (D10).
	if (!input.baseRoute) return { why: 'dispatch_unknown' };
	if (input.baseRoute.providerType !== OWN_ARM_TRANSPORT_KIND) return { why: 'not_own_mta' };
	return { ownArmShare: OWN_SHARE_CEILING };
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
 * `ownArmShare x audience`: quoting a 95%-relayed campaign a multi-day plan
 * computed over its whole audience would be exactly the false blocker D2
 * forbids.
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
