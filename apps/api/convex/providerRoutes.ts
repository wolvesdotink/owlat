import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { SES_RELAY_PROOF_MAX_AGE_MS } from '@owlat/shared';
import type { Doc } from './_generated/dataModel';
import { type MutationCtx, type QueryCtx } from './_generated/server';
import { authedQuery, authedMutation } from './lib/authedFunctions';
import { requireOrgPermission } from './lib/sessionOrganization';
import { messageTypeValidator } from './lib/sendProviders/route';
import { MTA_IP_POOL_NAMES } from './lib/sendProviders/types';
import { SEND_PROVIDER_CATALOG, isSendProviderKind } from './lib/sendProviders/catalog';
import { isSendProviderReady } from './lib/sendProviders/capability';
import {
	isFallbackRelayEligible,
	routeCarriesEnabledRelay,
	routeCarriesOwnArm,
} from './lib/sendProviders/fallbackEligibility';
import {
	enabledFallbackRelayKinds,
	ensureRelayIdentities,
	relayIdentityBackfills,
} from './lib/sendProviders/fallbackRelays';
import { OWN_SENDING_DOMAIN_PROVIDER_KIND } from './domains/providers';
import { logError } from './lib/runtimeLog';
import { throwInvalidInput } from './_utils/errors';
import { internal } from './_generated/api';
import { internalMutation } from './_generated/server';

/**
 * Provider Routes — CRUD operations for per-org email provider routing.
 *
 * Each organization can configure which email provider (mta, ses, resend)
 * to use for each message type (campaign, transactional, automation).
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
 */
export const listRoutes = authedQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db.query('providerRoutes').collect(); // bounded: configured provider routes (few)
	},
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
	handler: async () => {
		return [...MTA_IP_POOL_NAMES];
	},
});

/** Safe composed catalog; never exposes environment values or plugin code. */
// all-members: transport labels and readiness booleans are the same non-secret
// delivery state every member may already read from the routing/status surfaces.
export const listTransportCatalog = authedQuery({
	args: {},
	handler: async (ctx) => {
		return await Promise.all(
			SEND_PROVIDER_CATALOG.map(async (entry) => ({
				kind: entry.kind,
				label: entry.label,
				isAvailable: await isSendProviderReady(ctx, entry.kind),
			}))
		);
	},
});

/**
 * Operational SES relay DNS/status for every owned-MTA sending domain.
 *
 * STILL SES-ONLY, and knowingly so. This reads the frozen
 * `sendingDomainSesIdentities` sibling directly and shapes the result around
 * SES's DNS bundle (dkim tokens, MAIL FROM, `spfProofState`), which is what its
 * one consumer — `RelayDomainStatus.vue` — renders. The drain below now
 * backfills whichever kind the route named, so with a non-SES relay configured
 * this table reports `provisioning` for every domain forever: the identity
 * exists, in `sendingDomainRelayIdentities`, and this query cannot see it.
 *
 * Deliberately NOT fixed here. Making the read generic is not a table swap —
 * the per-kind identity shapes differ (Mandrill remembers provider VERDICTS,
 * not tokens, and derives its records), so the row this returns and the
 * component that renders it have to change together, and widening the read
 * shape from a wave-0 refactor would be exactly the user-visible change wave 0
 * is not allowed to make. This piece is the write half only. Until the pair
 * moves: a non-SES fallback relays correctly and reports nothing here.
 *
 * NO PIECE CURRENTLY OWNS THE FIX, and that is stated rather than wished away.
 * The natural home is P1.2 (catalog-driven web UI), but its scope names
 * `TransportEditor.vue`, `useSetupWizard.ts`, `useRelayCredentialDraft.ts`,
 * `DeliverabilityFallbackEditor.vue` and `config.vue` — neither this query nor
 * `RelayDomainStatus.vue`, which the plan mentions only in its duplication
 * inventory. So this pair is carried into P1.2 as an explicit added input (it
 * is called out by name in this piece's handoff notes); a reader who arrives
 * here from the code rather than from the plan should not conclude someone
 * already signed up for it.
 *
 * The divergence is at least PINNED rather than merely described:
 * `__tests__/providerRoutes.integration.test.ts` → "PINNED DIVERGENCE (P1.2)"
 * inserts a VERIFIED Mandrill relay identity and asserts this query still
 * answers `provisioning` with no DNS records. That test asserts today's broken
 * behaviour, so it cannot fail the fix into existence — it exists so that
 * whoever does make the read generic has to delete an assertion that spells out
 * what used to be wrong, instead of discovering the SES-shaped row by surprise.
 */
export const listDeliverabilityRelayDomains = authedQuery({
	args: { paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage');
		const page = await ctx.db
			.query('domains')
			.withIndex('by_provider_type', (q) => q.eq('providerType', OWN_SENDING_DOMAIN_PROVIDER_KIND))
			.paginate(args.paginationOpts);
		const now = Date.now();
		return {
			...page,
			page: await Promise.all(
				page.page.map(async (domain) => {
					const identity = await ctx.db
						.query('sendingDomainSesIdentities')
						.withIndex('by_domain', (q) => q.eq('domainId', domain._id))
						.first();
					return {
						domainId: domain._id,
						domain: domain.domain,
						status:
							domain.status !== 'verified'
								? ('awaiting_primary_verification' as const)
								: identity
									? identity.verifiedAt
										? now - identity.verifiedAt <= SES_RELAY_PROOF_MAX_AGE_MS
											? ('verified' as const)
											: ('stale' as const)
										: ('pending' as const)
									: ('provisioning' as const),
						dnsRecords: identity?.dnsRecords,
						verificationResults: identity?.verificationResults,
						spfProofState:
							identity?.spfProofState ??
							(identity?.dnsRecords?.spf
								? ('dns_required' as const)
								: ('not_applicable_manual_primary' as const)),
						isProviderVerified: identity?.isProviderVerified ?? false,
						verifiedAt: identity?.verifiedAt,
					};
				})
			),
		};
	},
});

/**
 * Cursor drain used when fallback is enabled; future domains use lifecycle
 * provisioning.
 *
 * WHICH relay is a PARAMETER, not a literal (plan D2). This mutation used to
 * name `sendingDomainSesIdentities` and `domains.sesRelay.provision` directly,
 * which was correct only for as long as SES was the one relay a route could
 * name. Since the fallback gate became a capability question, `resend`, `smtp`
 * and `mandrill` routes save too — and every one of them would have had SES
 * identities provisioned across the whole domain table, calling an API the
 * deployment may hold no credentials for and publishing DNS guidance for a
 * provider the operator never chose. The kind now travels from the route that
 * named it and the backfill is asked of THAT kind's sending-domain provider.
 *
 * A relay with nothing to register at (`domainVerification: 'none'`, so no
 * `ensureRelayIdentity` — Resend, a bring-your-own SMTP relay) stops the drain
 * before it reads a page: there is no identity to backfill, which is the same
 * honest posture `relayDomainVerification.ts` takes on the read side.
 *
 * `relayProviderType` IS OPTIONAL, and absent is a definite answer rather than
 * a no-op. Convex persists a scheduled function's arguments, so a continuation
 * this mutation scheduled for itself BEFORE the argument existed would fail
 * argument validation the moment the deploy lands — and the shipped gate
 * already admits `ses`, `resend`, `smtp` and `mandrill` fallbacks, so that
 * abandoned drain could belong to any of them. It would stop at its cursor and
 * every domain past it would keep no relay identity (the lifecycle's forward
 * path only covers domains verified LATER), which the operator only ever sees
 * as a refusal to relay, and only once the breaker opens. So absent means
 * "whichever relays the routes currently name" — resolved from the same
 * `providerRoutes` read the forward path uses, per page, so an operator who
 * changes the relay mid-drain gets the new one.
 */
export const provisionDeliverabilityRelayBatch = internalMutation({
	args: { relayProviderType: v.optional(v.string()), paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		const kinds =
			args.relayProviderType === undefined
				? await enabledFallbackRelayKinds(ctx)
				: [args.relayProviderType];
		// Resolved once per BATCH, not once per domain: an empty result means the
		// configured relay has nothing to register at, and the drain then stops
		// before it reads a page rather than paginating the whole domain table to
		// call nothing. The registry filter itself lives with the rule, in
		// `lib/sendProviders/fallbackRelays.ts` — the forward half of this pair
		// (`domains/lifecycle.ts`'s `provision_relay_identity_if_enabled` effect)
		// calls the same two functions, so neither half can grow a private idea of
		// which relay a domain's identity is for or of which domains get one.
		const backfills = relayIdentityBackfills(kinds);
		if (backfills.length === 0) return;
		const page = await ctx.db
			.query('domains')
			.withIndex('by_status', (q) => q.eq('status', 'verified'))
			.paginate(args.paginationOpts);
		// ONE SUMMARY PER PAGE, because the per-domain throw is swallowed so it
		// cannot roll the page back. Without it a page in which every domain's
		// backfill threw — a transient org lookup, a provider row that vanished —
		// commits as a success, schedules its successor and reports the drain
		// complete having provisioned nothing, and the only later symptom is the
		// relay refusing those From domains once the breaker opens.
		const failedByKind = new Map<string, number>();
		for (const domain of page.page) {
			const outcome = await ensureRelayIdentities(ctx, domain, backfills);
			for (const kind of outcome.failedKinds) {
				failedByKind.set(kind, (failedByKind.get(kind) ?? 0) + 1);
			}
		}
		if (failedByKind.size > 0) {
			logError(
				`[Relay identity] Drain page left ${page.page.length} domains partly unprovisioned: ` +
					[...failedByKind].map(([kind, count]) => `${kind}=${count}`).join(', ')
			);
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(500, internal.providerRoutes.provisionDeliverabilityRelayBatch, {
				relayProviderType: args.relayProviderType,
				paginationOpts: { cursor: page.continueCursor, numItems: args.paginationOpts.numItems },
			});
		}
	},
});

// ── Mutations ──────────────────────────────────────────────────────

/**
 * Set (upsert) a provider route for a message type.
 * Replaces any existing route for the same org + message type.
 */
export const setRoute = authedMutation({
	args: {
		messageType: messageTypeValidator,
		strategy: strategyValidator,
		providers: v.array(providerEntryValidator),
		ipPool: v.optional(v.string()),
		deliverabilityFallback: v.optional(deliverabilityFallbackValidator),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
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
			// THE SAME QUESTION ROUTING ASKS (D6). `resolveRoute` gates the relay on
			// `isFallbackRelayEligible`; this gate used to be
			// `relayProviderType !== 'ses'`, a list of one. Two different rules for
			// one decision is how a route becomes unsaveable through the mutation
			// while resolution would have carried it perfectly well — and, in the
			// other direction, how a route persisted before a kind was retired keeps
			// naming a relay routing refuses. One predicate, both sides.
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
			await ctx.scheduler.runAfter(0, internal.providerRoutes.provisionDeliverabilityRelayBatch, {
				relayProviderType: fallback.relayProviderType,
				paginationOpts: { cursor: null, numItems: 32 },
			});
		}
		return routeId;
	},
});

/**
 * Remove a provider route for a message type (reverts to global default).
 */
export const removeRoute = authedMutation({
	args: {
		messageType: messageTypeValidator,
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
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
	},
});
