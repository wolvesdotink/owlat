import { v, type ObjectType } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { type MutationCtx, type QueryCtx } from '../_generated/server';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import {
	requirePermission,
	hasPermission,
	type MutationSessionContext,
} from '../lib/sessionOrganization';
import { messageTypeValidator } from '../lib/sendProviders/route';
import { MTA_IP_POOL_NAMES } from '../lib/sendProviders/types';
import { SEND_PROVIDER_CATALOG, isSendProviderKind } from '../lib/sendProviders/catalog';
import { isSendProviderReady } from '../lib/sendProviders/capability';
import {
	isFallbackRelayEligible,
	routeCarriesEnabledRelay,
	routeCarriesOwnArm,
} from '../lib/sendProviders/fallbackEligibility';
import { throwInvalidInput } from '../_utils/errors';
import { internal } from '../_generated/api';

/**
 * Provider Routes — CRUD operations for per-org email provider routing.
 *
 * Each organization can configure which email provider — any
 * `SendTransportKind` the catalog declares, core or plugin; the kinds are not
 * re-listed here — to use for each message type (campaign,
 * transactional, automation). The relay identities a route's deliverability
 * fallback depends on, and their catch-up drain, are in `providerRouteRelays.ts`.
 *
 * Each builder's body is an exported helper, so the previous release's paths
 * (`providerRoutes.ts` at the convex root) run the same code.
 */

type MessageType = Doc<'providerRoutes'>['messageType'];

/**
 * Indexed single-route lookup used by the route setters/removers.
 * `by_message_type` is unique per type in practice, so `.first()` returns the
 * single configured row for that type.
 */
async function getRouteByType(
	ctx: QueryCtx | MutationCtx,
	messageType: MessageType
): Promise<Doc<'providerRoutes'> | null> {
	return await ctx.db
		.query('providerRoutes')
		.withIndex('by_message_type', (q) => q.eq('messageType', messageType))
		.first();
}

/**
 * Shared patch-or-insert body for the route setters. Patches the existing
 * row for `messageType` if present, otherwise inserts a new one.
 */
async function upsertRoute(
	ctx: MutationCtx,
	messageType: MessageType,
	fields: {
		strategy: Doc<'providerRoutes'>['strategy'];
		providers: Doc<'providerRoutes'>['providers'];
		ipPool?: string;
		deliverabilityFallback?: Doc<'providerRoutes'>['deliverabilityFallback'];
	}
): Promise<Doc<'providerRoutes'>['_id']> {
	const now = Date.now();
	const existing = await getRouteByType(ctx, messageType);

	if (existing) {
		await ctx.db.patch(existing._id, {
			strategy: fields.strategy,
			providers: fields.providers,
			ipPool: fields.ipPool,
			deliverabilityFallback: fields.deliverabilityFallback,
			updatedAt: now,
		});
		return existing._id;
	}

	return await ctx.db.insert('providerRoutes', {
		messageType,
		strategy: fields.strategy,
		providers: fields.providers,
		ipPool: fields.ipPool,
		deliverabilityFallback: fields.deliverabilityFallback,
		createdAt: now,
		updatedAt: now,
	});
}

const providerEntryValidator = v.object({
	providerType: v.string(),
	weight: v.optional(v.number()),
	isEnabled: v.boolean(),
});

// Mirrors `SendRouteStrategyKind` (lib/sendProviders/strategies/types.ts).
// `adaptive_mix` is CONTROLLER-OWNED: the ramp controller selects it, and the
// operator UI renders it read-only rather than offering it in the strategy
// picker. It is accepted here so an existing adaptive_mix row survives an
// unrelated edit — a validator that rejected the kind the schema already stores
// would silently downgrade the route on the next save.
const strategyValidator = v.union(
	v.literal('single'),
	v.literal('priority_failover'),
	v.literal('workload_split'),
	v.literal('adaptive_mix')
);

const deliverabilityFallbackValidator = v.object({
	isEnabled: v.boolean(),
	relayProviderType: v.string(),
	isWarmupOverflowEnabled: v.boolean(),
});

// ── Client-facing queries ──────────────────────────────────────────

/**
 * List all provider routes for the current organization.
 *
 * Admin-gated (`organization:manage`): a route row exposes the transport
 * topology — per-provider weights and the `ipPool` override — which is
 * operational configuration, not member-readable state. Held to the same
 * permission the route setters/removers (`setRoute` / `removeRoute`) require.
 */
export async function listProviderRoutes(ctx: QueryCtx, session: MutationSessionContext) {
	requirePermission(
		hasPermission(session.role, 'organization:manage'),
		'Only owners and admins can view provider routing'
	);
	return await ctx.db.query('providerRoutes').collect(); // bounded: configured provider routes (few)
}

// authz: listProviderRoutes requires organization:manage before it reads.
export const listRoutes = authedQuery({
	args: {},
	handler: async (ctx, _args, session) => await listProviderRoutes(ctx, session),
});

/**
 * The IP-pool names the built-in MTA understands. The provider-routing settings
 * UI uses these to autocomplete the per-route IP-pool override and to warn when
 * an operator types a pool name the MTA does not route through. Static (the MTA
 * pool set is a fixed capability, not per-org data), but exposed as a query so
 * the names stay server-owned and the client never hard-codes them.
 */
// all-members: a static, non-sensitive capability list (two fixed pool names,
// no org data, no credentials) — every member who can view provider routing may
// read it. Mirrors the member-visible `deliveryConfigured`.
export const listIpPools = authedQuery({
	args: {},
	handler: async () => listMtaIpPools(),
});

export function listMtaIpPools() {
	return [...MTA_IP_POOL_NAMES];
}

/** Safe composed catalog; never exposes environment values or plugin code. */
// all-members: transport labels and readiness booleans are the same non-secret
// delivery state every member may already read from the routing/status surfaces.
export const listTransportCatalog = authedQuery({
	args: {},
	handler: async (ctx) => await transportCatalog(ctx),
});

export async function transportCatalog(ctx: QueryCtx) {
	return await Promise.all(
		SEND_PROVIDER_CATALOG.map(async (entry) => ({
			kind: entry.kind,
			label: entry.label,
			isAvailable: await isSendProviderReady(ctx, entry.kind),
		}))
	);
}

// ── Mutations ──────────────────────────────────────────────────────

/**
 * Set (upsert) a provider route for a message type.
 * Replaces any existing route for the same org + message type.
 */
export const setRouteArgs = {
	messageType: messageTypeValidator,
	strategy: strategyValidator,
	providers: v.array(providerEntryValidator),
	ipPool: v.optional(v.string()),
	deliverabilityFallback: v.optional(deliverabilityFallbackValidator),
};

export async function saveRoute(
	ctx: MutationCtx,
	args: ObjectType<typeof setRouteArgs>,
	session: MutationSessionContext
) {
	requirePermission(
		hasPermission(session.role, 'organization:manage'),
		'Only owners and admins can change provider routing'
	);
	const seenKinds = new Set<string>();
	if (args.ipPool && !(MTA_IP_POOL_NAMES as readonly string[]).includes(args.ipPool)) {
		throwInvalidInput('Provider route contains an unknown MTA IP pool');
	}
	for (const provider of args.providers) {
		if (!isSendProviderKind(provider.providerType)) {
			throwInvalidInput('Provider route contains an unknown transport');
		}
		if (seenKinds.has(provider.providerType)) {
			throwInvalidInput('Provider route contains a duplicate transport');
		}
		seenKinds.add(provider.providerType);
		if (provider.isEnabled && !(await isSendProviderReady(ctx, provider.providerType))) {
			throwInvalidInput('Provider route contains an unavailable transport');
		}
	}
	const fallback = args.deliverabilityFallback;
	if (fallback?.isEnabled) {
		// THE SAME QUESTION ROUTING ASKS. `resolveRoute` gates the relay on
		// `isFallbackRelayEligible`, and so does this gate, rather than a list of
		// relay kinds. Two different rules for one decision is how a route
		// becomes unsaveable through the mutation while resolution would have
		// carried it perfectly well — and, in the other direction, how a route
		// persisted before a kind was retired keeps naming a relay routing
		// refuses. One predicate, both sides.
		//
		// Readiness is resolved BEFORE the predicate rather than inside it: the
		// authoritative source here is `isSendProviderReady` (env plus mutable
		// plugin grants), which is async, and the predicate takes a synchronous
		// source. It is asked about exactly one kind — the one being validated —
		// so the pre-resolution is a single lookup, not a map of the catalog.
		const relayKind = isSendProviderKind(fallback.relayProviderType)
			? fallback.relayProviderType
			: null;
		const isRelayReady = relayKind !== null && (await isSendProviderReady(ctx, relayKind));
		if (!isFallbackRelayEligible(fallback.relayProviderType, () => isRelayReady)) {
			throwInvalidInput('Deliverability fallback relay must be a configured non-MTA transport');
		}
		// The other two conditions, asked through the same module the
		// eligibility question comes from — and for the same reason. The
		// `deployment.relay` checklist item reports on exactly these three, so a
		// copy of either rule here is a copy that can start disagreeing with what
		// the operator is told about the route they just saved.
		if (!routeCarriesEnabledRelay(args.providers, fallback.relayProviderType)) {
			throwInvalidInput('Deliverability fallback relay must be enabled in this route');
		}
		if (!routeCarriesOwnArm(args.providers)) {
			throwInvalidInput('Deliverability fallback requires an enabled owned-MTA route');
		}
	}

	const routeId = await upsertRoute(ctx, args.messageType, {
		strategy: args.strategy,
		providers: args.providers,
		ipPool: args.ipPool,
		deliverabilityFallback: args.deliverabilityFallback,
	});
	if (fallback?.isEnabled) {
		await ctx.scheduler.runAfter(
			0,
			internal.delivery.providerRouteRelays.provisionDeliverabilityRelayBatch,
			{
				relayProviderType: fallback.relayProviderType,
				paginationOpts: { cursor: null, numItems: 32 },
			}
		);
	}
	return routeId;
}

// authz: saveRoute requires organization:manage before it writes.
export const setRoute = authedMutation({
	args: setRouteArgs,
	handler: async (ctx, args, session) => await saveRoute(ctx, args, session),
});

/**
 * Remove a provider route for a message type (reverts to global default).
 */
export const removeRouteArgs = {
	messageType: messageTypeValidator,
};

export async function deleteRoute(
	ctx: MutationCtx,
	args: ObjectType<typeof removeRouteArgs>,
	session: MutationSessionContext
) {
	requirePermission(
		hasPermission(session.role, 'organization:manage'),
		'Only owners and admins can change provider routing'
	);
	const existing = await getRouteByType(ctx, args.messageType);

	if (existing) {
		await ctx.db.delete(existing._id);
	}

	// Return a truthy value so callers can use the shared
	// `result === undefined` failure idiom (a caught throw resolves to
	// undefined); a no-op delete (no row) is still a successful reset.
	return { success: true };
}

// authz: deleteRoute requires organization:manage before it writes.
export const removeRoute = authedMutation({
	args: removeRouteArgs,
	handler: async (ctx, args, session) => await deleteRoute(ctx, args, session),
});
