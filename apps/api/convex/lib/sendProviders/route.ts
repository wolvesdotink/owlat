/**
 * Send route resolution (read seam).
 *
 * Single place that reads the provider-route config + provider-health
 * snapshots from the DB and runs the pure `resolveRoute` dispatcher. Both
 * the action send paths (via the `resolveSendRoute` internal query) and the
 * transactional intake mutation (via the `resolveSendRouteFromDb` helper,
 * reading in-transaction through `ctx.db`) share this so the lookup +
 * health-map + fallback sequence lives in one spot.
 */

import { v } from 'convex/values';
import { internalQuery, type MutationCtx, type QueryCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import {
	resolveRoute,
	DeliverabilityRouteError,
	GlobalDeliveryCircuitOpenError,
	type ProviderRouteConfig,
	type ProviderHealthStatus,
	type ResolvedRoute,
} from './routing';
import { isSendProviderReady } from './capability';
import { isSendProviderKind, type SendProviderKind } from './types';
import { getOptional } from '../env';
import { extractDomainOrNull, SES_RELAY_PROOF_MAX_AGE_MS } from '@owlat/shared';
import {
	destinationProviderForDomain,
	isActionableDeliverabilitySignalSource,
} from '@owlat/shared/deliverabilityRouting';
import { getSingletonOrganizationId } from '../sessionOrganization';
import { DELIVERABILITY_SIGNAL_MAX_AGE_MS } from '../../delivery/deliverabilityRouting';

export type MessageType = Doc<'providerRoutes'>['messageType'];

// Single source of truth for the message-type literal set (imported by
// providerRoutes.ts so the two can't drift).
export const messageTypeValidator = v.union(
	v.literal('campaign'),
	v.literal('transactional'),
	v.literal('automation')
);

/**
 * Resolve the send route for a message type from the current transaction.
 * Reads the route config (indexed) + all provider health, maps health rows
 * to the strategy-facing shape, and returns the resolved route. Pure
 * `resolveRoute` owns the null/empty/fallback semantics.
 */
export async function resolveSendRouteFromDb(
	ctx: QueryCtx | MutationCtx,
	messageType: MessageType,
	addressContext?: {
		to?: string;
		from?: string;
		now?: number;
		baseOnly?: boolean;
		forceRelayReason?: 'breaker_open' | 'warmup_overflow';
	}
): Promise<ResolvedRoute | null> {
	const routeConfig = await ctx.db
		.query('providerRoutes')
		.withIndex('by_message_type', (q) => q.eq('messageType', messageType))
		.first();

	const healthRecords = await ctx.db.query('providerHealth').collect(); // bounded: providerHealth has one row per provider kind (3 today)
	const healthStatuses: ProviderHealthStatus[] = healthRecords.map((h) => ({
		providerType: h.providerType,
		status: h.status,
		successRate: h.successRate,
	}));
	const candidateKinds = new Set<SendProviderKind>();
	for (const provider of routeConfig?.providers ?? []) {
		if (isSendProviderKind(provider.providerType)) candidateKinds.add(provider.providerType);
	}
	const envProvider = getOptional('EMAIL_PROVIDER');
	if (isSendProviderKind(envProvider)) candidateKinds.add(envProvider);
	const readyKinds = new Set<SendProviderKind>();
	for (const kind of candidateKinds) {
		if (await isSendProviderReady(ctx, kind)) readyKinds.add(kind);
	}

	const deliverability = addressContext?.baseOnly
		? undefined
		: await deliverabilityInput(ctx, routeConfig, messageType, addressContext);

	const resolved = resolveRoute(
		routeConfig as ProviderRouteConfig | null,
		healthStatuses,
		(kind) => readyKinds.has(kind),
		deliverability
	);
	return resolved
		? {
				...resolved,
				warmupOverflowEnabled: Boolean(
					messageType === 'campaign' && routeConfig?.deliverabilityFallback?.isWarmupOverflowEnabled
				),
			}
		: null;
}

async function deliverabilityInput(
	ctx: QueryCtx | MutationCtx,
	routeConfig: Doc<'providerRoutes'> | null,
	messageType: MessageType,
	addressContext?: {
		to?: string;
		from?: string;
		now?: number;
		baseOnly?: boolean;
		forceRelayReason?: 'breaker_open' | 'warmup_overflow';
	}
) {
	if (!addressContext?.to) return undefined;
	const toDomain = extractDomainOrNull(addressContext.to);
	if (!toDomain) return undefined;
	const now = addressContext.now ?? Date.now();
	let organizationId: string;
	try {
		organizationId = await getSingletonOrganizationId(ctx);
	} catch {
		return undefined;
	}
	const learnedProvider = await ctx.db
		.query('destinationProviderDomains')
		.withIndex('by_org_domain', (q) =>
			q.eq('organizationId', organizationId).eq('domain', toDomain)
		)
		.first();
	const provider =
		learnedProvider && learnedProvider.expiresAt >= now
			? learnedProvider.destinationProvider
			: destinationProviderForDomain(toDomain);
	const [providerState, globalState, warmingState] = await Promise.all([
		ctx.db
			.query('deliverabilityRouteStates')
			.withIndex('by_org_provider', (q) =>
				q.eq('organizationId', organizationId).eq('destinationProvider', provider)
			)
			.first(),
		ctx.db
			.query('deliverabilityRouteStates')
			.withIndex('by_org_provider', (q) =>
				q.eq('organizationId', organizationId).eq('destinationProvider', 'all')
			)
			.first(),
		messageType === 'campaign' && routeConfig?.deliverabilityFallback?.isWarmupOverflowEnabled
			? ctx.db.query('warmingState').first()
			: Promise.resolve(null),
	]);
	const freshActive = [globalState, providerState].filter(
		(state) => state?.isFallbackActive && now - state.updatedAt <= DELIVERABILITY_SIGNAL_MAX_AGE_MS
	);
	// Advisory readings ("blocklist lookup unavailable", "part of the pool is
	// ejected") are recorded on the state row for measurement, but they are not
	// routing reasons and must never appear as the cause of a relay fallback.
	const activeReasons = freshActive.flatMap(
		(state) =>
			state?.signals.map((s) => s.source).filter(isActionableDeliverabilitySignalSource) ?? []
	);
	if (addressContext.forceRelayReason === 'breaker_open') activeReasons.unshift('breaker_open');
	const isWarmupOverflow = Boolean(
		addressContext.forceRelayReason === 'warmup_overflow' ||
		(warmingState &&
			now - warmingState.syncedAt <= DELIVERABILITY_SIGNAL_MAX_AGE_MS &&
			warmingState.phase !== 'graduated' &&
			warmingState.totalDailyCap > 0 &&
			warmingState.totalSentToday >= warmingState.totalDailyCap)
	);
	const fromDomain = addressContext.from ? extractDomainOrNull(addressContext.from) : null;
	const isRelayDomainVerified =
		fromDomain && routeConfig?.deliverabilityFallback?.isEnabled
			? await relayDomainVerified(
					ctx,
					fromDomain,
					routeConfig.deliverabilityFallback.relayProviderType,
					now
				)
			: false;
	const isGlobalBreakerOpen = Boolean(
		globalState?.isFallbackActive &&
		now - globalState.updatedAt <= DELIVERABILITY_SIGNAL_MAX_AGE_MS &&
		globalState.signals.some((signal) => signal.source === 'breaker_open')
	);
	return { activeReasons, isWarmupOverflow, isRelayDomainVerified, isGlobalBreakerOpen };
}

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

async function relayDomainVerified(
	ctx: QueryCtx | MutationCtx,
	domainName: string,
	relayProviderType: string,
	now: number
): Promise<boolean> {
	if (relayProviderType !== 'ses') return false;
	const domain = await ctx.db
		.query('domains')
		.withIndex('by_domain', (q) => q.eq('domain', domainName.toLowerCase()))
		.first();
	if (!domain) return false;
	const identity = await ctx.db
		.query('sendingDomainSesIdentities')
		.withIndex('by_domain', (q) => q.eq('domainId', domain._id))
		.first();
	if (
		!identity?.dnsRecords ||
		!identity.verificationResults ||
		!identity.isProviderVerified ||
		!identity.verifiedAt ||
		now - identity.verifiedAt > SES_RELAY_PROOF_MAX_AGE_MS
	)
		return false;
	const proof = identity.verificationResults;
	const spfProofState =
		identity.spfProofState ??
		(identity.dnsRecords.spf ? 'dns_required' : 'not_applicable_manual_primary');
	const spfSatisfied =
		spfProofState === 'dns_required'
			? Boolean(identity.dnsRecords.spf && proof.spf?.verified)
			: domain.providerType === 'mta' &&
				domain.status === 'verified' &&
				!identity.dnsRecords.spf &&
				!proof.spf;
	const results = [
		...(spfProofState === 'dns_required' ? [proof.spf] : []),
		...(proof.dkim ?? []),
		...(proof.mailFrom ?? []),
	];
	return Boolean(
		spfSatisfied &&
		identity.dkimTokens.length > 0 &&
		proof.dkim?.length === identity.dkimTokens.length &&
		proof.dkim.every((result) => result.verified) &&
		identity.dnsRecords.mailFrom?.length &&
		proof.mailFrom?.length === identity.dnsRecords.mailFrom.length &&
		proof.mailFrom.every((result) => result.verified) &&
		results.every((result) => {
			if (!result || !Number.isFinite(result.lastChecked)) return false;
			const age = now - result.lastChecked;
			return age >= 0 && age <= SES_RELAY_PROOF_MAX_AGE_MS;
		})
	);
}

/**
 * Refusals that mean "not right now", not "never".
 *
 * `resolveRoute` throws for an open org-wide safety circuit and for a
 * fallback whose relay identity is unverified or unavailable. Both are
 * transient states — the error text says "temporarily deferred" — but a throw
 * crossing an action boundary loses its class, surfaces as a workpool failure,
 * and terminalizes the Send as `WORKPOOL_FAILED`. Opening the safety circuit
 * would then burn every in-flight campaign send instead of pausing it. The
 * governed queries below convert them to a typed deferral, which the last-mile
 * boundary turns into a bounded retry (capped by the routing attempt limit and
 * the four-day delivery deadline).
 */
export type RoutingDeferralCode =
	| 'GLOBAL_DELIVERY_CIRCUIT_OPEN'
	| 'DELIVERABILITY_RELAY_DOMAIN_UNVERIFIED'
	| 'DELIVERABILITY_RELAY_UNAVAILABLE';

function routingDeferralCode(error: unknown): RoutingDeferralCode | null {
	if (error instanceof GlobalDeliveryCircuitOpenError) return error.code;
	if (error instanceof DeliverabilityRouteError) return error.code;
	return null;
}

/**
 * Internal query wrapper for action callers (which can only reach the DB via
 * `ctx.runQuery`). Folds the route lookup, the provider-health read, and the
 * caller-side `resolveRoute` into one round-trip.
 */
export const resolveSendRoute = internalQuery({
	args: {
		messageType: messageTypeValidator,
		to: v.optional(v.string()),
		from: v.optional(v.string()),
		baseOnly: v.optional(v.boolean()),
		forceRelayReason: v.optional(v.union(v.literal('breaker_open'), v.literal('warmup_overflow'))),
	},
	handler: async (ctx, args): Promise<ResolvedRoute | null> => {
		return await resolveSendRouteFromDb(ctx, args.messageType, {
			to: args.to,
			from: args.from,
			baseOnly: args.baseOnly,
			forceRelayReason: args.forceRelayReason,
		});
	},
});

/**
 * Resolve both the policy-aware route and its underlying strategy route for
 * the last-mile action. The action uses the base candidate only for an MTA
 * recovery probe; the policy-aware route remains authoritative for every
 * persisted Convex safety signal.
 */
export async function resolveLastMileRoutePlanFromDb(
	ctx: QueryCtx,
	messageType: MessageType,
	addressContext: { to: string; from: string }
): Promise<{
	route: ResolvedRoute | null;
	baseRoute: ResolvedRoute | null;
	isMtaGoverned: boolean;
	deferralCode?: RoutingDeferralCode;
}> {
	const routeConfig = await ctx.db
		.query('providerRoutes')
		.withIndex('by_message_type', (q) => q.eq('messageType', messageType))
		.first();
	const isHybrid = Boolean(
		routeConfig?.deliverabilityFallback?.isEnabled &&
		routeConfig.providers.some((provider) => provider.isEnabled && provider.providerType === 'mta')
	);
	try {
		const route = await resolveSendRouteFromDb(ctx, messageType, addressContext);
		const baseRoute = await resolveSendRouteFromDb(ctx, messageType, {
			...addressContext,
			baseOnly: true,
		});
		return { route, baseRoute, isMtaGoverned: isHybrid || baseRoute?.providerType === 'mta' };
	} catch (error) {
		const deferralCode = routingDeferralCode(error);
		if (!deferralCode) throw error;
		return { route: null, baseRoute: null, isMtaGoverned: isHybrid, deferralCode };
	}
}

export const resolveLastMileRoutePlan = internalQuery({
	args: {
		messageType: messageTypeValidator,
		to: v.string(),
		from: v.string(),
	},
	handler: async (ctx, args) =>
		await resolveLastMileRoutePlanFromDb(ctx, args.messageType, { to: args.to, from: args.from }),
});

/**
 * The relay a governed send falls back to once the MTA hands back an
 * overflow/breaker decision. Reports a transient refusal instead of throwing,
 * so an unverified or unavailable relay defers the message rather than
 * terminalizing it.
 */
export async function resolveGovernedRelayRouteFromDb(
	ctx: QueryCtx,
	messageType: MessageType,
	options: {
		to?: string;
		from?: string;
		forceRelayReason: 'breaker_open' | 'warmup_overflow';
	}
): Promise<{ route: ResolvedRoute | null; deferralCode?: RoutingDeferralCode }> {
	try {
		return { route: await resolveSendRouteFromDb(ctx, messageType, options) };
	} catch (error) {
		const deferralCode = routingDeferralCode(error);
		if (!deferralCode) throw error;
		return { route: null, deferralCode };
	}
}

export const resolveGovernedRelayRoute = internalQuery({
	args: {
		messageType: messageTypeValidator,
		to: v.optional(v.string()),
		from: v.optional(v.string()),
		forceRelayReason: v.union(v.literal('breaker_open'), v.literal('warmup_overflow')),
	},
	handler: async (ctx, args) =>
		await resolveGovernedRelayRouteFromDb(ctx, args.messageType, {
			to: args.to,
			from: args.from,
			forceRelayReason: args.forceRelayReason,
		}),
});
