import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { sendingHoldStatusValidator } from '../lib/validators/deliverability';

/**
 * What each announcement that sending stopped did on every alert channel
 * (`delivery/sendingHoldAlerts.ts`), for the Deliverability Center. A hold is
 * not a `deliverabilityRegressionAlerts` row, so it keeps its own record; the
 * channel fields carry that table's names, so one writer and one reader serve
 * both (`delivery/checklistAlertChannelLedger.ts`).
 *
 * Its own schema sibling because `schema/delivery.ts` is at the file-size cap.
 * Spread into `defineSchema()` from schema.ts via `...sendingHoldAlertTables`.
 */
export const sendingHoldAlertTables = {
	// One row per raise: sending stopping, or its status changing while it
	// stays stopped (suspended to banned and back). A resume writes none; the
	// Center shows only the hold that stands.
	sendingHoldAlerts: defineTable({
		// The `alertId` the webhook carries: one per stretch of stopped sending.
		alertId: v.string(),
		holdStatus: sendingHoldStatusValidator,
		// Set when this raise changed the status of a hold that already stood.
		previousHoldStatus: v.optional(sendingHoldStatusValidator),
		reason: v.string(),
		// The status change this raise announces; with `alertId`, its identity.
		announcedAt: v.number(),
		emailNotificationState: v.union(
			v.literal('pending'),
			v.literal('sent'),
			v.literal('unavailable')
		),
		// Recipients whose email the transport accepted, and those waiting on a retry.
		emailAcceptedCount: v.number(),
		emailRetryingCount: v.number(),
		// System mail leaves over the built-in MTA, the server the hold is about.
		isEmailOnAffectedTransport: v.boolean(),
		// The channels off the mail path, as on a regression alert. Absent means
		// not attempted yet.
		inAppNoticeCount: v.optional(v.number()),
		pushDeliveredCount: v.optional(v.number()),
		pushFailedCount: v.optional(v.number()),
		pushHeldCount: v.optional(v.number()),
		webhookDeliveryLogIds: v.optional(v.array(v.id('webhookDeliveryLogs'))),
	}).index('by_alert_announced', ['alertId', 'announcedAt']),
};
