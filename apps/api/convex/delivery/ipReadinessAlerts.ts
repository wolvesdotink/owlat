/** Persistent, admin-visible incident seam for confirmed MTA IPv6 regressions. */

import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import { mtaIpReadinessAlertFields } from '../schema/delivery';

const ALERT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;

export const recordRegression = internalMutation({
	args: mtaIpReadinessAlertFields,
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
