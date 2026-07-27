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
import { returnPathCapabilityFor } from '../../delivery/relayReturnPath';
import { SEND_PROVIDER_CATALOG } from './catalog';
import { defaultSendTransportId } from './transports';

export type MessageType = Doc<'providerRoutes'>['messageType'];

// Single source of truth for the message-type literal set (imported by
// providerRoutes.ts so the two can't drift).
export const messageTypeValidator = v.union(
	v.literal('campaign'),
	v.literal('transactional'),
	v.literal('automation')
);

/**
 * Every provider kind route resolution may pick for this message type.
 *
 * BOTH sources, because resolution has both: the saved routing row AND
 * `EMAIL_PROVIDER`. A deployment only ever gets a `providerRoutes` row once an
 * operator saves the routing screen, so on the canonical bring-your-own-relay
 * install (`EMAIL_PROVIDER=smtp` + `SMTP_RELAY_*`, no routing row) the relay is
 * reached exclusively through `resolveRoute`'s env fallback. Anything that asks
 * "could this message go out over kind X?" must ask THIS function, or it will
 * be narrower than what `resolveRoute` can actually return.
 */
function sendRouteCandidateKinds(
	routeConfig: ProviderRouteConfig | null
): ReadonlySet<SendProviderKind> {
	const kinds = new Set<SendProviderKind>();
	for (const provider of routeConfig?.providers ?? []) {
		// Disabled entries are dropped by `resolveRoute` before readiness is ever
		// asked, so they are not candidates.
		if (provider.isEnabled && isSendProviderKind(provider.providerType)) {
			kinds.add(provider.providerType);
		}
	}
	const envProvider = getOptional('EMAIL_PROVIDER');
	if (isSendProviderKind(envProvider)) kinds.add(envProvider);
	return kinds;
}

/**
 * The one candidate kind whose envelope-sender control is decided by a PROBE
 * rather than by the catalog (`yes` stamps its own VERP, `no` owns the envelope
 * sender and would never honour ours). `null` when this route has none.
 *
 * Iterates the CATALOG rather than the candidate set so the answer does not
 * depend on the order an operator happened to list providers in.
 */
function probeableCandidateKind(
	candidateKinds: ReadonlySet<SendProviderKind>
): SendProviderKind | null {
	for (const entry of SEND_PROVIDER_CATALOG) {
		if (entry.supportsCustomReturnPath === 'probe' && candidateKinds.has(entry.kind)) {
			return entry.kind;
		}
	}
	return null;
}

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
	const candidateKinds = sendRouteCandidateKinds(routeConfig as ProviderRouteConfig | null);
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
	addressContext: { to: string; from: string; now?: number }
): Promise<{
	route: ResolvedRoute | null;
	baseRoute: ResolvedRoute | null;
	isMtaGoverned: boolean;
	deferralCode?: RoutingDeferralCode;
	/**
	 * May a relay send stamp OUR VERP envelope sender (plan G-08)? Answered
	 * HERE, inside the routing query the send path already runs, rather than in
	 * a second round trip from the dispatcher — the hot send path should not
	 * grow a query per message to read a deployment-scoped fact.
	 */
	relayStampVerpReturnPath: boolean;
}> {
	const now = addressContext.now ?? Date.now();
	const routeConfig = await ctx.db
		.query('providerRoutes')
		.withIndex('by_message_type', (q) => q.eq('messageType', messageType))
		.first();
	// Only a relay whose envelope-sender control is decided by OBSERVATION can
	// carry our VERP address, so the gate is derived — not hard-coded — from the
	// candidate set resolution itself uses: any kind the catalog marks `probe`.
	// Deriving it from `sendRouteCandidateKinds` is what keeps it from being
	// narrower than what `resolveRoute` may return; the bring-your-own-relay
	// install reaches its relay through the ENV fallback with no `providerRoutes`
	// row at all, and gating on the row alone left every one of those sends
	// unstamped while the sweep kept proving the capability.
	//
	// Candidates rather than the resolved route, because the warm-up overflow /
	// breaker-open fallback selects its relay AFTER this query returns, and that
	// route must still be stamped. An mta/ses/resend-only route resolves no probe
	// kind and pays for no read.
	//
	// `defaultSendTransportId` is the instance the GOVERNED dispatcher sends
	// through (`delivery/governedDispatch.ts`), so the transport graded here and
	// the transport used on the wire are the same one by construction.
	const relayCandidateKind = probeableCandidateKind(
		sendRouteCandidateKinds(routeConfig as ProviderRouteConfig | null)
	);
	const relayStampVerpReturnPath =
		relayCandidateKind === null
			? false
			: (await returnPathCapabilityFor(ctx, defaultSendTransportId(relayCandidateKind), now))
					.stampVerpReturnPath;
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
		return {
			route,
			baseRoute,
			isMtaGoverned: isHybrid || baseRoute?.providerType === 'mta',
			relayStampVerpReturnPath,
		};
	} catch (error) {
		const deferralCode = routingDeferralCode(error);
		if (!deferralCode) throw error;
		return {
			route: null,
			baseRoute: null,
			isMtaGoverned: isHybrid,
			deferralCode,
			relayStampVerpReturnPath,
		};
	}
}

export const resolveLastMileRoutePlan = internalQuery({
	args: {
		messageType: messageTypeValidator,
		to: v.string(),
		from: v.string(),
		// No clock argument, deliberately — the sibling `resolveSendRoute` exposes
		// none either. `now` lives on the …FromDb helper for tests, which call it
		// directly; accepting one over the wire would let a backdated value revive
		// a TTL-expired return-path verdict.
	},
	handler: async (ctx, args) =>
		await resolveLastMileRoutePlanFromDb(ctx, args.messageType, {
			to: args.to,
			from: args.from,
		}),
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
