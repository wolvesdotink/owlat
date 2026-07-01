import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import {
	type MutationCtx,
	type QueryCtx,
} from './_generated/server';
import { authedQuery, authedMutation } from './lib/authedFunctions';
import { requireOrgPermission } from './lib/sessionOrganization';
import { messageTypeValidator } from './lib/sendProviders/route';
import { MTA_IP_POOL_NAMES } from './lib/sendProviders/types';

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
	messageType: MessageType,
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
	},
): Promise<Doc<'providerRoutes'>['_id']> {
	const now = Date.now();
	const existing = await getRouteByType(ctx, messageType);

	if (existing) {
		await ctx.db.patch(existing._id, {
			strategy: fields.strategy,
			providers: fields.providers,
			ipPool: fields.ipPool,
			updatedAt: now,
		});
		return existing._id;
	}

	return await ctx.db.insert('providerRoutes', {
		messageType,
		strategy: fields.strategy,
		providers: fields.providers,
		ipPool: fields.ipPool,
		createdAt: now,
		updatedAt: now,
	});
}

const providerEntryValidator = v.object({
	providerType: v.string(),
	weight: v.optional(v.number()),
	isEnabled: v.boolean(),
});

const strategyValidator = v.union(
	v.literal('single'),
	v.literal('priority_failover'),
	v.literal('workload_split')
);

// ── Client-facing queries ──────────────────────────────────────────

/**
 * List all provider routes for the current organization.
 */
export const listRoutes = authedQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db
			.query('providerRoutes')
			.collect();
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
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can change provider routing');

		return await upsertRoute(ctx, args.messageType, {
			strategy: args.strategy,
			providers: args.providers,
			ipPool: args.ipPool,
		});
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
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can change provider routing');
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

