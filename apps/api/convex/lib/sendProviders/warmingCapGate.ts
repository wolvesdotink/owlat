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
import type { ResolvedRoute } from './routing';
import { relayDomainVerified, resolveSendRouteFromDb, routingDeferralCode } from './route';
import { isSendProviderReady } from './capability';
import { isSendProviderKind, type SendProviderKind } from './types';
import { getOptional } from '../env';
import { extractDomainOrNull } from '@owlat/shared';

/**
 * The base (pre-deliverability) campaign route, or `null` if the shipped
 * resolution cannot produce one. `resolveRoute` signals an unusable relay
 * configuration by throwing; here that is not a failure to report but simply
 * "no MTA-only base route", which the caller reads as "the cap does not bind".
 */
async function resolveCampaignBaseRouteOrNull(
	ctx: QueryCtx | MutationCtx
): Promise<ResolvedRoute | null> {
	try {
		return await resolveSendRouteFromDb(ctx, 'campaign', { baseOnly: true });
	} catch (error) {
		if (routingDeferralCode(error)) return null;
		throw error;
	}
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
 * does not apply). Answering `false` therefore means "unknown / not subject to
 * the cap → allow".
 *
 * Two shipped configurations answer `false`:
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
 *     WHAT COUNTS AS "not on the own MTA" DEPENDS ON THE STRATEGY. Under
 *     `workload_split` every enabled base provider carries a share of the
 *     audience, so a single non-MTA entry is enough to let part of the audience
 *     bypass the cap. Under `single` and `priority_failover` a second provider
 *     is a HEALTH failover, not a traffic split: with the MTA selected and
 *     healthy, 100% of campaign traffic still goes through it and the cap binds
 *     exactly as this gate describes. Those strategies therefore ask the
 *     SHIPPED resolution (`resolveSendRouteFromDb(..., { baseOnly: true })`)
 *     which base provider is actually selected, rather than re-deriving it.
 *
 * Either way the entries are judged READY, not merely enabled — `resolveRoute`
 * filters route entries through `isSendProviderReady`, so an enabled but
 * credential-less SES entry alongside the MTA is not a route and must not turn
 * this gate off.
 *
 * Lives here rather than in the gate because this module already owns both
 * reads — the campaign route row and the relay-domain re-verification.
 */
export async function campaignWarmingCapBinds(
	ctx: QueryCtx | MutationCtx,
	options: { fromEmail?: string | undefined; now: number }
): Promise<boolean> {
	const routeConfig = await ctx.db
		.query('providerRoutes')
		.withIndex('by_message_type', (q) => q.eq('messageType', 'campaign'))
		.first();

	const fallbackConfig = routeConfig?.deliverabilityFallback;
	const enabledKinds: SendProviderKind[] = [];
	for (const provider of routeConfig?.providers ?? []) {
		const kind = provider.providerType;
		if (!provider.isEnabled) continue;
		if (!isSendProviderKind(kind)) continue;
		if (!(await isSendProviderReady(ctx, kind))) continue;
		enabledKinds.push(kind);
	}

	// Whatever the strategy, if nothing resolves — or resolution itself rejects
	// the configuration — the campaign is not dispatching through a capped MTA.
	// The send fails its own configuration checks long before capacity matters,
	// and refusing here would be a second, wrong reason.
	const baseRoute = await resolveCampaignBaseRouteOrNull(ctx);
	if (!baseRoute) return false;

	if (routeConfig?.strategy === 'workload_split') {
		// The relay is an ESCAPE HATCH, not a normal campaign path: `resolveRoute`
		// only selects it once a deliverability reason fires, so it is excluded
		// here and judged on its own below.
		const baseKinds: readonly (string | undefined)[] = fallbackConfig?.isEnabled
			? enabledKinds.filter((kind) => kind !== fallbackConfig.relayProviderType)
			: enabledKinds;
		// No usable route entry: `resolveRoute` falls through to the
		// `EMAIL_PROVIDER` env default, so that is what campaigns dispatch through.
		const campaignKinds = baseKinds.length > 0 ? baseKinds : [getOptional('EMAIL_PROVIDER')];
		if (!campaignKinds.every((kind) => kind === 'mta')) return false;
	} else if (baseRoute.providerType !== 'mta') {
		return false;
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
		return true;
	}
	const fromDomain = options.fromEmail ? extractDomainOrNull(options.fromEmail) : null;
	if (!fromDomain) return true;
	const overflowAvailable = await relayDomainVerified(
		ctx,
		fromDomain,
		fallbackConfig.relayProviderType,
		options.now
	);
	return !overflowAvailable;
}
