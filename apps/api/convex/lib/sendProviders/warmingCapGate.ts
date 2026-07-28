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
import { isSendProviderKind, type SendProviderKind } from './types';
import { extractDomainOrNull } from '@owlat/shared';

/**
 * The base (pre-deliverability) campaign resolution from ONE pass over the
 * route tables: the route row, the readiness set, and the route the shipped
 * resolver selected — or `route: null` when it cannot select one.
 *
 * `resolveRoute` signals an unusable relay configuration by throwing. That is
 * not a failure to report here, but it also must NOT collapse the whole
 * resolution: the facts it threw over — which providers are configured, enabled
 * and ready — are exactly what the `workload_split` branch below decides from,
 * and they are already read. Losing them was the source of the non-deterministic
 * verdict: under `workload_split` the throw fires only on the draws where the
 * weighted selector happened to land on the relay entry.
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
export type WarmingCapVerdict = { binds: true } | { binds: false; why: WarmingCapNotBindingReason };

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
 *     WHAT COUNTS AS "not on the own MTA" DEPENDS ON THE STRATEGY, and so does
 *     WHAT THE ANSWER MAY BE DERIVED FROM.
 *
 *     `workload_split` selects among the enabled+ready entries by WEIGHTED
 *     RANDOM draw (strategies/workload_split), so the selected route is not a
 *     function of the configuration and must never be consulted here: the card
 *     requires a decidable predicate, and the preview query and the binding gate
 *     are separate calls that would otherwise quote the operator two different
 *     answers. Under this strategy EVERY enabled+ready entry carries a share of
 *     the audience — including a relay entry that also serves as the
 *     deliverability escape hatch — so the verdict is read off the enabled+ready
 *     KIND SET alone, and one non-MTA entry is enough to let part of the
 *     audience bypass the cap.
 *
 *     `single` (first enabled entry) and `priority_failover` (deterministic
 *     order) select deterministically, and there a second provider is a HEALTH
 *     failover rather than a traffic split: with the MTA selected and healthy,
 *     100% of campaign traffic still goes through it and the cap binds exactly
 *     as this gate describes. Those strategies therefore ask the SHIPPED
 *     resolution which base provider is actually selected, rather than
 *     re-deriving it.
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

	if (routeConfig?.strategy === 'workload_split') {
		// DECIDE FROM THE CONFIGURATION, NEVER FROM THE SELECTED ROUTE. The
		// weighted-random selector makes `baseRoute` a coin flip under this
		// strategy. Every enabled+ready entry carries a share of the audience —
		// a relay entry included, because here it is a normal traffic-carrying
		// path and not only the deliverability escape hatch — so the whole set is
		// the campaign's dispatch surface.
		//
		// No usable route entry at all: `resolveRoute` has ALREADY fallen through
		// to the `EMAIL_PROVIDER` env default, so the resolved base route names
		// the kind campaigns dispatch through — reading the env again would be a
		// second place the two answers can disagree. That fallback is itself
		// deterministic (`fallback()` in routing.ts ignores the strategy), so
		// consulting `baseRoute` is sound in exactly this case. With no base route
		// either, nothing is known about where campaigns dispatch: hold and allow.
		const campaignKinds: readonly SendProviderKind[] =
			enabledKinds.length > 0 ? enabledKinds : baseRoute ? [baseRoute.providerType] : [];
		if (campaignKinds.length === 0) return { binds: false, why: 'dispatch_unknown' };
		if (!campaignKinds.every((kind) => kind === 'mta')) {
			return { binds: false, why: 'not_own_mta' };
		}
	} else if (!baseRoute) {
		// Neither strategy could select a route — `resolveRoute` threw a routing
		// deferral and even the env default did not apply. Where campaigns
		// dispatch is simply unknown.
		return { binds: false, why: 'dispatch_unknown' };
	} else if (baseRoute.providerType !== 'mta') {
		return { binds: false, why: 'not_own_mta' };
	}

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
		return { binds: true };
	}
	const fromDomain = options.fromEmail ? extractDomainOrNull(options.fromEmail) : null;
	if (!fromDomain) return { binds: true };
	const overflowAvailable = await relayDomainVerified(
		ctx,
		fromDomain,
		fallbackConfig.relayProviderType,
		options.now
	);
	return overflowAvailable ? { binds: false, why: 'warmup_overflow_absorbs' } : { binds: true };
}
