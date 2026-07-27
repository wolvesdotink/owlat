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
import { extractDomainOrNull } from '@owlat/shared';
import { resolveDestinationProvider } from './destinationProvider';
import { loadRouteStateCell, loadStreamlessRouteState } from '../deliverabilityRouteState';
import { getSingletonOrganizationId } from '../sessionOrganization';
import { DELIVERABILITY_SIGNAL_MAX_AGE_MS } from '../../delivery/deliverabilityRouting';
import { relayReturnPathHostFor } from '../../delivery/relayReturnPath';
import { isProbeDecidedReturnPathKind, SEND_PROVIDER_CATALOG } from './catalog';
import type { SendProviderKind } from './types';
import {
	candidateSendProviderKinds,
	freshFallbackReasons,
	isGlobalBreakerOpenState,
	messageTypeValidator,
	readySendProviderKinds,
	relayDomainVerifiedFor,
	type MessageType,
} from './routeInputs';

// `MessageType` and `messageTypeValidator` live in `routeInputs.ts` — the module
// that holds what BOTH resolvers read — and are re-exported here for existing
// importers, so the health-free cell seam never needs an import edge to this
// module.
export { messageTypeValidator, type MessageType };

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
}

/**
 * The one candidate kind whose envelope-sender control is decided by a PROBE
 * rather than by the catalog (`yes` stamps its own VERP, `no` owns the envelope
 * sender and would never honour ours). `null` when this route has none.
 *
 * Iterates the CATALOG rather than the candidate set so the answer does not
 * depend on the order an operator happened to list providers in, and asks the
 * catalog's own predicate so this gate and the probe sweep can never disagree
 * about what is probe-decided.
 */
function probeableCandidateKind(
	candidateKinds: ReadonlySet<SendProviderKind>
): SendProviderKind | null {
	for (const entry of SEND_PROVIDER_CATALOG) {
		if (isProbeDecidedReturnPathKind(entry.kind) && candidateKinds.has(entry.kind)) {
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
	const provider = await resolveDestinationProvider(ctx, organizationId, toDomain, now);
	const [providerCell, globalState, warmingState] = await Promise.all([
		// Cell lookup: BOTH the controller's per-stream row and the stream-less row
		// the MTA snapshot maintains, so neither can shadow the other.
		loadRouteStateCell(ctx, organizationId, { stream: messageType, destinationProvider: provider }),
		// The global slice is infrastructure-wide and never per-stream: read the
		// stream-less row directly so a per-stream `all` row could never hide the
		// breaker_open signal the snapshot writes there.
		loadStreamlessRouteState(ctx, organizationId, 'all'),
		messageType === 'campaign' && routeConfig?.deliverabilityFallback?.isWarmupOverflowEnabled
			? ctx.db.query('warmingState').first()
			: Promise.resolve(null),
	]);
	// EVERY row of the cell is considered, not just the most specific one: the
	// per-stream row carries the controller's share and the stream-less row
	// carries the infrastructure signals, so reading only one would drop a hard
	// stop. `freshFallbackReasons` applies D1's share resolution and the
	// advisory-signal filter for both call sites.
	const activeReasons = freshFallbackReasons(
		[globalState, providerCell.streamless, providerCell.perStream],
		now
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
	addressContext: { to: string; from: string; now?: number }
): Promise<{
	route: ResolvedRoute | null;
	baseRoute: ResolvedRoute | null;
	isMtaGoverned: boolean;
	deferralCode?: RoutingDeferralCode;
	/**
	 * The return-path host a RELAY send may stamp as its VERP envelope sender
	 * (plan G-08), or `undefined` to keep the composer's — the shipped
	 * behaviour. Answered HERE, inside the routing query the send path already
	 * runs, rather than in a second round trip from the dispatcher.
	 */
	relayReturnPathHost?: string | undefined;
}> {
	const now = addressContext.now ?? Date.now();
	const routeConfig = await ctx.db
		.query('providerRoutes')
		.withIndex('by_message_type', (q) => q.eq('messageType', messageType))
		.first();
	// Only a relay whose envelope-sender control is decided by OBSERVATION can
	// carry our VERP address, so the gate is derived — not hard-coded — from the
	// candidate set resolution itself uses: any kind the catalog marks `probe`.
	// Deriving it from `candidateSendProviderKinds` is what keeps it from being
	// narrower than what `resolveRoute` may return; the bring-your-own-relay
	// install reaches its relay through the ENV fallback with no `providerRoutes`
	// row at all, and gating on the row alone left every one of those sends
	// unstamped while the sweep kept proving the capability.
	//
	// Candidates rather than the resolved route, because the warm-up overflow /
	// breaker-open fallback selects its relay AFTER this query returns, and that
	// route must still be stamped.
	//
	// COST: a route with NO probe-decided candidate (mta/ses/resend only) pays
	// nothing. A route that CAN reach the relay — including a hybrid mta+smtp
	// one, whose sends mostly resolve to the MTA — pays one indexed read of the
	// transport's probe row on every governed send. That read is what
	// `relayReturnPathHostFor` short-circuits on: only a relay already PROVEN to
	// honour a custom return path goes on to read the From domain, so the
	// common hybrid case stays at exactly one row.
	const relayCandidateKind = probeableCandidateKind(candidateSendProviderKinds(routeConfig));
	const relayReturnPathHost =
		relayCandidateKind === null
			? undefined
			: await relayReturnPathHostFor(ctx, relayCandidateKind, addressContext.from, now);
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
			relayReturnPathHost,
		};
	} catch (error) {
		const deferralCode = routingDeferralCode(error);
		if (!deferralCode) throw error;
		return {
			route: null,
			baseRoute: null,
			isMtaGoverned: isHybrid,
			deferralCode,
			relayReturnPathHost,
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
