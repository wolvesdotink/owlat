/** Persistent, admin-visible incident seam for confirmed MTA IPv6 regressions. */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import { adminQuery } from '../lib/authedFunctions';

const ALERT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;
const READ_BATCH_LIMIT = 100;

const alertArgs = {
	eventId: v.string(),
	ip: v.string(),
	readinessCheck: v.union(v.literal('fcrdns'), v.literal('spf')),
	readinessReason: v.string(),
	eligibilityGeneration: v.number(),
	observedAt: v.number(),
	message: v.string(),
};

export const recordRegression = internalMutation({
	args: alertArgs,
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('mtaIpReadinessAlerts')
			.withIndex('by_event_id', (q) => q.eq('eventId', args.eventId))
			.unique();
		if (existing) {
			const duplicate =
				existing.ip === args.ip &&
				existing.readinessCheck === args.readinessCheck &&
				existing.readinessReason === args.readinessReason &&
				existing.eligibilityGeneration === args.eligibilityGeneration &&
				existing.observedAt === args.observedAt &&
				existing.message === args.message;
			if (!duplicate) throw new Error('IP readiness alert event-id collision');
			return { ok: true as const, duplicate: true };
		}
		await ctx.db.insert('mtaIpReadinessAlerts', { ...args, createdAt: Date.now() });
		return { ok: true as const, duplicate: false };
	},
});

export const listRecent = adminQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const requestedLimit = args.limit ?? 50;
		const limit = Number.isFinite(requestedLimit)
			? Math.max(1, Math.min(READ_BATCH_LIMIT, Math.floor(requestedLimit)))
			: 50;
		return await ctx.db
			.query('mtaIpReadinessAlerts')
			.withIndex('by_observed_at')
			.order('desc')
			.take(limit);
	},
});

export const cleanupExpired = internalMutation({
	args: {},
	handler: async (ctx) => {
		const expired = await ctx.db
			.query('mtaIpReadinessAlerts')
			.withIndex('by_observed_at', (q) => q.lt('observedAt', Date.now() - ALERT_RETENTION_MS))
			.take(CLEANUP_BATCH_SIZE);
		await Promise.all(expired.map((alert) => ctx.db.delete(alert._id)));
		if (expired.length === CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.delivery.ipReadinessAlerts.cleanupExpired, {});
		}
		return { deleted: expired.length };
	},
});
