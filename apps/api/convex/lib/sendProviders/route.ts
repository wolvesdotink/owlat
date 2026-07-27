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
import { extractDomainOrNull } from '@owlat/shared';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import { resolveDestinationProvider } from './destinationProvider';
import { relayDomainVerified } from './relayDomainVerification';
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
 * Per-message inputs the deliverability layer keys off. Shared by
 * `resolveSendRouteFromDb` and its internal `deliverabilityInput` so the two
 * shapes cannot drift.
 */
export interface SendRouteAddressContext {
	to?: string;
	from?: string;
	now?: number;
	baseOnly?: boolean;
	forceRelayReason?: 'breaker_open' | 'warmup_overflow';
	/**
	 * Pre-classified destination provider for `to`. Purely an optimisation:
	 * when omitted the resolver classifies `to` itself. A batch caller that
	 * has already memoized one classification per distinct domain passes it
	 * so the classifier point read stays O(distinct domains).
	 */
	destinationProvider?: DestinationProviderKey;
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
	addressContext?: SendRouteAddressContext
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
	const readyKinds = await readySendProviderKinds(ctx, routeConfig);

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

/**
 * Which provider kinds are runtime-ready for this route config (credentials +
 * flag + capability grant). Shared by the full resolver and the cell seam so
 * the two cannot disagree about what "enabled" means.
 */
async function readySendProviderKinds(
	ctx: QueryCtx | MutationCtx,
	routeConfig: Doc<'providerRoutes'> | null
): Promise<Set<SendProviderKind>> {
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
	return readyKinds;
}

/**
 * The two `deliverabilityRouteStates` rows a decision keys off: the
 * destination-provider row and the org-wide `all` row. Both indexed point
 * reads (`by_org_provider`).
 */
async function deliverabilityRouteStatesFor(
	ctx: QueryCtx | MutationCtx,
	organizationId: string,
	provider: DestinationProviderKey
): Promise<[Doc<'deliverabilityRouteStates'> | null, Doc<'deliverabilityRouteStates'> | null]> {
	return await Promise.all([
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
	]);
}

/** Fallback reasons carried by the FRESH active route states, in order. */
function freshFallbackReasons(
	states: ReadonlyArray<Doc<'deliverabilityRouteStates'> | null>,
	now: number
) {
	return states
		.filter(
			(state) =>
				state?.isFallbackActive && now - state.updatedAt <= DELIVERABILITY_SIGNAL_MAX_AGE_MS
		)
		.flatMap((state) => state?.signals.map((signal) => signal.source) ?? []);
}

/** True when the org-wide state carries a fresh `breaker_open` signal. */
function isGlobalBreakerOpenState(
	globalState: Doc<'deliverabilityRouteStates'> | null,
	now: number
): boolean {
	return Boolean(
		globalState?.isFallbackActive &&
		now - globalState.updatedAt <= DELIVERABILITY_SIGNAL_MAX_AGE_MS &&
		globalState.signals.some((signal) => signal.source === 'breaker_open')
	);
}

/** Relay-domain verification for the envelope From, when a relay is configured. */
async function relayDomainVerifiedFor(
	ctx: QueryCtx | MutationCtx,
	routeConfig: Doc<'providerRoutes'> | null,
	from: string | undefined,
	now: number
): Promise<boolean> {
	const fromDomain = from ? extractDomainOrNull(from) : null;
	if (!fromDomain || !routeConfig?.deliverabilityFallback?.isEnabled) return false;
	return await relayDomainVerified(
		ctx,
		fromDomain,
		routeConfig.deliverabilityFallback.relayProviderType,
		now
	);
}

/** Per-CELL inputs for {@link resolveCellRouteFromDb}. */
export interface CellRouteContext {
	/** The cell's destination provider — the axis the fallback is keyed on. */
	readonly destinationProvider: DestinationProviderKey;
	/** Envelope From; feeds the shipped relay-domain verification input. */
	readonly from?: string;
	readonly now: number;
	readonly organizationId: string;
}

/**
 * Per-CELL route resolution for BATCH callers, from cold/warm inputs only.
 *
 * `resolveSendRouteFromDb` is the authoritative per-message resolution and it
 * reads `providerHealth` — a document that is read-modify-written once per
 * dispatch (`health.ts recordSendResult`). Pulling that hotspot into a
 * campaign enqueue transaction (which also performs ~50 workpool enqueues)
 * would make every concurrent dispatch invalidate the enqueue's read set and
 * drive OCC retries on a transaction that must not fail. So this seam answers
 * the DELIVERABILITY question — "does this cell relay, and to which
 * transport?" — from inputs that no send patches:
 *
 *   - `providerRoutes` (indexed, admin-written),
 *   - `deliverabilityRouteStates` (`by_org_provider`, written by the
 *     ip-reputation sync cron),
 *   - the relay-domain verification (`domains` /
 *     `sendingDomainSesIdentities`, both admin/verification-written).
 *
 * Deliberately NOT read here:
 *   - `providerHealth` — health-driven failover stays with the worker's
 *     authoritative re-resolution at dispatch (`governedDispatch.ts`);
 *   - `warmingState` — warm-up overflow is a point-in-time volume condition,
 *     and the timezone branch enqueues up to 24h before dispatch, so an
 *     enqueue-time reading of it would predict nothing.
 *
 * Returns `null` when nothing can be recorded honestly (no route, or the
 * org-wide delivery circuit is open — the message is not going anywhere
 * right now, and a guessed arm is worse than a missing row).
 */
export async function resolveCellRouteFromDb(
	ctx: QueryCtx | MutationCtx,
	messageType: MessageType,
	context: CellRouteContext
): Promise<ResolvedRoute | null> {
	const routeConfig = await ctx.db
		.query('providerRoutes')
		.withIndex('by_message_type', (q) => q.eq('messageType', messageType))
		.first();
	const [providerState, globalState] = await deliverabilityRouteStatesFor(
		ctx,
		context.organizationId,
		context.destinationProvider
	);
	if (isGlobalBreakerOpenState(globalState, context.now)) return null;
	const readyKinds = await readySendProviderKinds(ctx, routeConfig);
	return resolveRoute(
		routeConfig as ProviderRouteConfig | null,
		undefined,
		(kind) => readyKinds.has(kind),
		{
			activeReasons: freshFallbackReasons([globalState, providerState], context.now),
			isWarmupOverflow: false,
			isRelayDomainVerified: await relayDomainVerifiedFor(
				ctx,
				routeConfig,
				context.from,
				context.now
			),
		}
	);
}

async function deliverabilityInput(
	ctx: QueryCtx | MutationCtx,
	routeConfig: Doc<'providerRoutes'> | null,
	messageType: MessageType,
	addressContext?: SendRouteAddressContext
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
	// A caller that has ALREADY classified this recipient (the send-assignment
	// writer memoizes one classification per distinct domain across a batch)
	// passes the provider in so this resolver does not repeat the point read.
	const provider =
		addressContext.destinationProvider ??
		(await resolveDestinationProvider(ctx, organizationId, toDomain, now));
	const [[providerState, globalState], warmingState] = await Promise.all([
		deliverabilityRouteStatesFor(ctx, organizationId, provider),
		messageType === 'campaign' && routeConfig?.deliverabilityFallback?.isWarmupOverflowEnabled
			? ctx.db.query('warmingState').first()
			: Promise.resolve(null),
	]);
	const activeReasons = freshFallbackReasons([globalState, providerState], now);
	if (addressContext.forceRelayReason === 'breaker_open') activeReasons.unshift('breaker_open');
	const isWarmupOverflow = Boolean(
		addressContext.forceRelayReason === 'warmup_overflow' ||
		(warmingState &&
			now - warmingState.syncedAt <= DELIVERABILITY_SIGNAL_MAX_AGE_MS &&
			warmingState.phase !== 'graduated' &&
			warmingState.totalDailyCap > 0 &&
			warmingState.totalSentToday >= warmingState.totalDailyCap)
	);
	const isRelayDomainVerified = await relayDomainVerifiedFor(
		ctx,
		routeConfig,
		addressContext.from,
		now
	);
	const isGlobalBreakerOpen = isGlobalBreakerOpenState(globalState, now);
	return { activeReasons, isWarmupOverflow, isRelayDomainVerified, isGlobalBreakerOpen };
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
