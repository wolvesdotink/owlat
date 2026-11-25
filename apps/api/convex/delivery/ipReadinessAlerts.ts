/**
 * Confirmed MTA IPv6 regressions: the MTA quarantined an IPv6 source because
 * its FCrDNS or return-path SPF stopped holding.
 *
 * The incident row is the MTA's record. Admins hear about it through the
 * Center's IPv6 checks, which read the same readiness from the MTA's synced
 * pool state: the event re-runs those checks at once instead of waiting for the
 * hourly or daily sweep, so a check that had passed regresses and raises its
 * alert (email, in-app notice, push, webhook) the way every other check does.
 * The checks keep their own rules: none runs on a deployment that does not
 * send through the built-in MTA, and none alerts while IPv6 is off.
 */

import type { DeliverabilityCheckId } from '@owlat/shared';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { internalMutation } from '../lib/writeFence';
import { mtaIpReadinessAlertFields } from '../schema/delivery';
import { isChecklistItemApplicable, loadDeliverabilitySendPaths } from './checklistApplicability';
import { ipv6SendingAddresses } from './checklistIpv6';

const ALERT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;

const readinessCheckValidator = mtaIpReadinessAlertFields.readinessCheck;

/** The Center checks that read the readiness the MTA quarantined on, plus the pool lock it caused. */
const CHECKS_FOR_READINESS = {
	fcrdns: ['deployment.ipv6_ptr', 'deployment.ipv6_aaaa', 'deployment.ipv6_pool'],
	spf: ['deployment.ipv6_spf', 'deployment.ipv6_pool'],
} as const satisfies Record<string, readonly DeliverabilityCheckId[]>;

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
		await ctx.scheduler.runAfter(0, internal.delivery.ipReadinessAlerts.recheckAfterRegression, {
			readinessCheck: args.readinessCheck,
		});
		return { ok: true as const, duplicate: false };
	},
});

/** Pull the MTA's pool state the checks read, then run them. */
export const recheckAfterRegression = internalAction({
	args: { readinessCheck: readinessCheckValidator },
	handler: async (ctx, args): Promise<void> => {
		// A failed sync leaves the last snapshot; the checks then judge that one
		// (and warn on a stale one) rather than not running at all.
		await ctx.runAction(internal.delivery.warmingSync.syncWarmingState, {}).catch(() => undefined);
		await ctx.runMutation(internal.delivery.ipReadinessAlerts.scheduleRegressedChecks, args);
	},
});

export const scheduleRegressedChecks = internalMutation({
	args: { readinessCheck: readinessCheckValidator },
	handler: async (ctx, args): Promise<{ scheduled: DeliverabilityCheckId[] }> => {
		const warming = await ctx.db.query('warmingState').first(); // bounded: singleton row
		if (ipv6SendingAddresses(warming).length === 0) return { scheduled: [] };
		const sendPaths = await loadDeliverabilitySendPaths(ctx);
		const organizationId = await getSingletonOrganizationId(ctx);
		const scheduled = CHECKS_FOR_READINESS[args.readinessCheck].filter((itemId) =>
			isChecklistItemApplicable(itemId, sendPaths)
		);
		for (const itemId of scheduled) {
			await ctx.scheduler.runAfter(0, internal.delivery.checklistVerification.sweep, {
				organizationId,
				itemId,
			});
		}
		return { scheduled };
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
