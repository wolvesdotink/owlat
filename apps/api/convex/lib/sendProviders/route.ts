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
	messageType: MessageType
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

	return resolveRoute(routeConfig as ProviderRouteConfig | null, healthStatuses, (kind) =>
		readyKinds.has(kind)
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
	},
	handler: async (ctx, args): Promise<ResolvedRoute | null> => {
		return await resolveSendRouteFromDb(ctx, args.messageType);
	},
});
