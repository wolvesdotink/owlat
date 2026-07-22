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
	type ProviderRouteConfig,
	type ProviderHealthStatus,
	type ResolvedRoute,
} from './routing';
import { isSendProviderReady } from './capability';
import { isSendProviderKind, type SendProviderKind } from './types';
import { getOptional } from '../env';
import { extractDomainOrNull } from '@owlat/shared';
import { destinationProviderForDomain } from '@owlat/shared/deliverabilityRouting';
import { getSingletonOrganizationId } from '../sessionOrganization';
import { DELIVERABILITY_SIGNAL_MAX_AGE_MS } from '../../delivery/deliverabilityRouting';

const SES_RELAY_PROOF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
	const activeReasons = freshActive.flatMap((state) => state?.signals.map((s) => s.source) ?? []);
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
	const results = [proof.spf, ...(proof.dkim ?? []), ...(proof.mailFrom ?? [])];
	return Boolean(
		proof.spf?.verified &&
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
export const resolveLastMileRoutePlan = internalQuery({
	args: {
		messageType: messageTypeValidator,
		to: v.string(),
		from: v.string(),
	},
	handler: async (ctx, args) => {
		const routeConfig = await ctx.db
			.query('providerRoutes')
			.withIndex('by_message_type', (q) => q.eq('messageType', args.messageType))
			.first();
		const route = await resolveSendRouteFromDb(ctx, args.messageType, {
			to: args.to,
			from: args.from,
		});
		const baseRoute = await resolveSendRouteFromDb(ctx, args.messageType, {
			to: args.to,
			from: args.from,
			baseOnly: true,
		});
		const isHybrid = Boolean(
			routeConfig?.deliverabilityFallback?.isEnabled &&
			routeConfig.providers.some(
				(provider) => provider.isEnabled && provider.providerType === 'mta'
			)
		);
		return {
			route,
			baseRoute,
			isMtaGoverned: isHybrid || baseRoute?.providerType === 'mta',
		};
	},
});
